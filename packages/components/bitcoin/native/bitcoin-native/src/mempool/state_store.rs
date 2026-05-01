use napi::Result;
use napi_derive::napi;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

use crate::utils::{now_ms, number_field, parse_txid, string_field, txid_to_hex, TxKey};

use super::snapshot::{empty_snapshot, ensure_snapshot_v2};

fn convert_units(units: Option<String>) -> (&'static str, f64) {
  match units.as_deref().unwrap_or("MB") {
    "B" => ("B", 1.0),
    "KB" => ("KB", 1024.0),
    "GB" => ("GB", 1024.0 * 1024.0 * 1024.0),
    _ => ("MB", 1024.0 * 1024.0),
  }
}

/// Memory-oriented backing store used by the TypeScript Mempool aggregate.
///
/// This struct is intentionally NOT a domain model and NOT a CQRS aggregate.
/// The TS `Mempool` keeps command methods, event handlers, provider calls and
/// domain events. Native code only owns the heavy in-memory indexes and lookup
/// structures used by the aggregate state.
///
/// Data layout
/// -----------
/// - `txids: Vec<TxKey>` stores each canonical txid once as 32 raw bytes.
/// - `txid_to_handle: HashMap<TxKey, u32>` maps the full txid to a compact
///   numeric handle. The full txid is still checked by the hash map, so this
///   avoids the old `hashTxid32` collision problem while keeping the rest of the
///   store handle-based.
/// - `provider_tx: HashMap<String, Vec<u32>>` stores provider membership as
///   compact handles instead of repeated txid strings.
/// - `metadata`, `transactions` and `load_tracker` are keyed by handle. Their
///   payloads intentionally remain `serde_json::Value` for this migration step,
///   because the aggregate API still exchanges JS objects.
///
/// Algorithmic complexity
/// ----------------------
/// - `ensure_handle`: average O(1) hash lookup/insert.
/// - `handle_of_txid`: average O(1) after parsing the hex txid.
/// - `apply_snapshot`: O(N + L), where N is the number of tx entries in the
///   provider snapshot and L is the number of already loaded transactions/load
///   records preserved across refreshes. It rebuilds provider indexes from the
///   new snapshot and keeps loaded data only for txids that remain present.
/// - `pending_txids(provider, limit)`: O(K) in the number of tx handles known
///   for that provider, stopping early once `limit` pending txids are found.
/// - `record_loaded`: O(M) for M loaded transactions.
/// - point lookups (`hasTransaction`, `getMetadata`, `getFullTransaction`):
///   average O(1).
/// - snapshot export/import: O(T + R), where T is known txid count and R is the
///   number of stored provider/metadata/transaction/load records.
///
/// Memory model
/// ------------
/// This store is optimized to reduce duplicated strings and JS collection
/// overhead, not to be a fully typed mempool yet. Approximate native index cost:
/// - canonical txid storage: 32 bytes per txid plus `Vec` capacity overhead;
/// - txid hash index: roughly tens of bytes per txid, depending on hash-map
///   capacity and allocator behavior;
/// - provider membership: 4 bytes per handle plus `Vec` capacity overhead,
///   instead of storing another txid string per provider reference;
/// - load tracker: small JSON object per loaded transaction;
/// - metadata and loaded transactions: variable-size JSON DOM values and usually
///   the dominant part until those payloads are moved to typed Rust structs.
///
/// `getMemoryUsage()` returns a stable heuristic useful for comparing runs. It
/// is not an exact allocator/heap measurement.
#[derive(Default)]
struct MempoolBackingStore {
  txid_to_handle: HashMap<TxKey, u32>,
  txids: Vec<TxKey>,
  provider_tx: HashMap<String, Vec<u32>>,
  metadata: HashMap<u32, Value>,
  transactions: HashMap<u32, Value>,
  load_tracker: HashMap<u32, Value>,
}

impl MempoolBackingStore {
  fn clear(&mut self) {
    self.txid_to_handle.clear();
    self.txids.clear();
    self.provider_tx.clear();
    self.metadata.clear();
    self.transactions.clear();
    self.load_tracker.clear();
  }

  /// Clears and shrinks all native containers.
  ///
  /// `clear()` preserves allocation capacity for fast reuse after refresh/import.
  /// `dispose()` is different: it is used when the TS aggregate/model is being
  /// torn down and memory should be returned to the allocator as eagerly as
  /// Rust allows.
  fn dispose(&mut self) {
    self.clear();
    self.txid_to_handle.shrink_to_fit();
    self.txids.shrink_to_fit();
    self.provider_tx.shrink_to_fit();
    self.metadata.shrink_to_fit();
    self.transactions.shrink_to_fit();
    self.load_tracker.shrink_to_fit();
  }

  /// Returns the compact handle for `key`, inserting it once if needed.
  ///
  /// Average complexity: O(1). The canonical 32-byte txid remains the map key,
  /// so a hash collision in Rust's map cannot alias two different txids because
  /// equality still compares the complete `[u8; 32]` key.
  fn ensure_handle(&mut self, key: TxKey) -> u32 {
    if let Some(handle) = self.txid_to_handle.get(&key) {
      return *handle;
    }

    let handle = self.txids.len() as u32;
    self.txid_to_handle.insert(key, handle);
    self.txids.push(key);
    handle
  }

  fn handle_of_txid(&self, txid: &str) -> Option<u32> {
    parse_txid(txid).and_then(|key| self.txid_to_handle.get(&key).copied())
  }

  fn import_pair(&mut self, entry: &Value, target: PairTarget) {
    let Value::Array(pair) = entry else {
      return;
    };

    if pair.len() != 2 {
      return;
    }

    let Some(txid) = pair[0].as_str() else {
      return;
    };

    let Some(key) = parse_txid(txid) else {
      return;
    };

    let handle = self.ensure_handle(key);

    match target {
      PairTarget::Metadata => {
        self.metadata.insert(handle, pair[1].clone());
      }
      PairTarget::Transaction => {
        self.transactions.insert(handle, pair[1].clone());
      }
      PairTarget::LoadTracker => {
        self.load_tracker.insert(handle, pair[1].clone());
      }
    }
  }
}

#[derive(Clone, Copy)]
enum PairTarget {
  Metadata,
  Transaction,
  LoadTracker,
}

/// N-API wrapper exposed to JS as `NativeMempoolState` for compatibility with
/// the TypeScript native registry. It delegates to `MempoolBackingStore` and
/// must be used only as a private state/index engine inside `MempoolStateStore`.
#[napi]
pub struct NativeMempoolState {
  store: MempoolBackingStore,
}

#[napi]
impl NativeMempoolState {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      store: MempoolBackingStore::default(),
    }
  }

  /// Applies a provider snapshot prepared by the TS aggregate/event handler.
  /// Existing loaded transactions/load info are preserved for txids that remain
  /// present in the new snapshot.
  ///
  /// Algorithm:
  /// 1. Build temporary maps from old handles back to full txids for loaded
  ///    transactions and load-tracker records.
  /// 2. Clear all indexes that describe the current mempool snapshot.
  /// 3. Rebuild txid handles, provider membership and metadata from the new
  ///    snapshot, deduplicating txids globally across providers.
  /// 4. Restore loaded transaction/load records only when their txid is still
  ///    present in the refreshed mempool.
  ///
  /// Complexity: O(N + L) time, O(L) temporary memory. N is snapshot tx count;
  /// L is the previous loaded transaction/load-tracker count.
  #[napi(js_name = "applySnapshot")]
  pub fn apply_snapshot(&mut self, per_provider: Value) -> Result<()> {
    let mut old_tx: HashMap<TxKey, Value> = HashMap::new();
    let mut old_load: HashMap<TxKey, Value> = HashMap::new();

    for (handle, tx) in &self.store.transactions {
      if let Some(key) = self.store.txids.get(*handle as usize) {
        old_tx.insert(*key, tx.clone());
      }
    }

    for (handle, info) in &self.store.load_tracker {
      if let Some(key) = self.store.txids.get(*handle as usize) {
        old_load.insert(*key, info.clone());
      }
    }

    self.store.clear();

    let mut seen = HashSet::new();

    let Value::Object(providers) = per_provider else {
      return Ok(());
    };

    for (provider, items) in providers {
      let mut handles = Vec::new();

      let Value::Array(arr) = items else {
        continue;
      };

      for item in arr {
        let Some(txid) = string_field(&item, "txid") else {
          continue;
        };
        let Some(metadata) = item.get("metadata").cloned() else {
          continue;
        };
        let Some(key) = parse_txid(txid) else {
          continue;
        };

        if !seen.insert(key) {
          continue;
        }

        let handle = self.store.ensure_handle(key);
        handles.push(handle);
        self.store.metadata.insert(handle, metadata);

        if let Some(tx) = old_tx.remove(&key) {
          self.store.transactions.insert(handle, tx);
        }

        if let Some(load) = old_load.remove(&key) {
          self.store.load_tracker.insert(handle, load);
        }
      }

      if !handles.is_empty() {
        self.store.provider_tx.insert(provider, handles);
      }
    }

    Ok(())
  }

  #[napi]
  pub fn providers(&self) -> Vec<String> {
    self.store.provider_tx.keys().cloned().collect()
  }

  /// Selects txids that still need a full/slim transaction load for one provider.
  ///
  /// Complexity: O(K) in that provider's handle list, with early stop after
  /// `limit` pending txids. The method only checks compact handles and avoids
  /// scanning the whole global mempool when a provider-specific list exists.
  #[napi(js_name = "pendingTxids")]
  pub fn pending_txids(&self, provider_name: String, limit: f64) -> Vec<String> {
    let mut out = Vec::new();
    let limit = limit.max(0.0) as usize;

    if limit == 0 {
      return out;
    }

    if let Some(handles) = self.store.provider_tx.get(&provider_name) {
      for handle in handles {
        if out.len() >= limit {
          break;
        }

        if self.store.load_tracker.contains_key(handle) || !self.store.metadata.contains_key(handle) {
          continue;
        }

        if let Some(key) = self.store.txids.get(*handle as usize) {
          out.push(txid_to_hex(*key));
        }
      }
    }

    out
  }

  /// Records loaded transactions returned by TS provider calls.
  ///
  /// Complexity: O(M) for M loaded items. Each txid is resolved to a compact
  /// handle and then the transaction JSON plus load info are stored by handle.
  /// Duplicate loads are ignored, preserving the first successful load info.
  #[napi(js_name = "recordLoaded")]
  pub fn record_loaded(&mut self, loaded_transactions: Vec<Value>) -> Result<()> {
    let timestamp = now_ms();

    for item in loaded_transactions {
      let Some(txid) = string_field(&item, "txid") else {
        continue;
      };
      let Some(transaction) = item.get("transaction").cloned() else {
        continue;
      };
      let Some(key) = parse_txid(txid) else {
        continue;
      };

      let handle = self.store.ensure_handle(key);

      if self.store.load_tracker.contains_key(&handle) {
        continue;
      }

      let fee_rate = number_field(&transaction, "feeRate").unwrap_or(0.0);
      let mut load = Map::new();
      load.insert("timestamp".into(), json!(timestamp));
      load.insert("feeRate".into(), json!(fee_rate));

      if let Some(provider) = string_field(&item, "providerName") {
        load.insert("providerName".into(), json!(provider));
      }

      self.store.transactions.insert(handle, transaction);
      self.store.load_tracker.insert(handle, Value::Object(load));
    }

    Ok(())
  }

  #[napi(js_name = "txIds")]
  pub fn tx_ids(&self) -> Vec<String> {
    self.store.txids.iter().map(|key| txid_to_hex(*key)).collect()
  }

  #[napi(js_name = "loadedTransactions")]
  pub fn loaded_transactions(&self) -> Vec<Value> {
    self.store.transactions.values().cloned().collect()
  }

  #[napi]
  pub fn metadata(&self) -> Vec<Value> {
    self.store.metadata.values().cloned().collect()
  }

  #[napi(js_name = "hasTransaction")]
  pub fn has_transaction(&self, txid: String) -> bool {
    self.store.handle_of_txid(&txid).is_some()
  }

  #[napi(js_name = "isTransactionLoaded")]
  pub fn is_transaction_loaded(&self, txid: String) -> bool {
    self
      .store
      .handle_of_txid(&txid)
      .map(|h| self.store.load_tracker.contains_key(&h))
      .unwrap_or(false)
  }

  #[napi(js_name = "getTransactionMetadata")]
  pub fn get_transaction_metadata(&self, txid: String) -> Option<Value> {
    self.store.handle_of_txid(&txid).and_then(|h| self.store.metadata.get(&h).cloned())
  }

  #[napi(js_name = "getFullTransaction")]
  pub fn get_full_transaction(&self, txid: String) -> Option<Value> {
    self.store.handle_of_txid(&txid).and_then(|h| self.store.transactions.get(&h).cloned())
  }

  #[napi(js_name = "getStats")]
  pub fn get_stats(&self) -> Value {
    json!({
      "txids": self.store.txids.len(),
      "metadata": self.store.metadata.len(),
      "transactions": self.store.transactions.len(),
      "providers": self.store.provider_tx.len(),
    })
  }

  #[napi(js_name = "getMemoryUsage")]
  pub fn get_memory_usage(&self, units: Option<String>) -> Value {
    let (unit, factor) = convert_units(units);
    let txids = self.store.txids.len() as f64;
    let metadata = self.store.metadata.len() as f64;
    let transactions = self.store.transactions.len() as f64;
    let loaded = self.store.load_tracker.len() as f64;
    let providers = self.store.provider_tx.len();

    let tx_index_bytes = txids * 40.0;
    let metadata_bytes = metadata * 350.0;
    let tx_store_bytes = transactions * 2000.0;
    let load_tracker_bytes = loaded * 48.0;
    let provider_map_bytes = txids * 12.0;
    let total = tx_index_bytes + metadata_bytes + tx_store_bytes + load_tracker_bytes + provider_map_bytes;
    let conv = |b: f64| (b / factor * 100.0).round() / 100.0;

    json!({
      "unit": unit,
      "counts": {
        "txids": self.store.txids.len(),
        "metadata": self.store.metadata.len(),
        "transactions": self.store.transactions.len(),
        "loaded": self.store.load_tracker.len(),
        "providers": providers,
      },
      "bytes": {
        "txIndex": conv(tx_index_bytes),
        "metadata": conv(metadata_bytes),
        "txStore": conv(tx_store_bytes),
        "loadTracker": conv(load_tracker_bytes),
        "providerTx": conv(provider_map_bytes),
        "total": conv(total),
      }
    })
  }

  #[napi(js_name = "exportSnapshot")]
  pub fn export_snapshot(&self) -> Value {
    let txids: Vec<String> = self.store.txids.iter().map(|key| txid_to_hex(*key)).collect();

    let provider_tx: Vec<Value> = self
      .store
      .provider_tx
      .iter()
      .map(|(provider, handles)| {
        let ids: Vec<String> = handles
          .iter()
          .filter_map(|h| self.store.txids.get(*h as usize))
          .map(|key| txid_to_hex(*key))
          .collect();
        json!([provider, ids])
      })
      .collect();

    let metadata: Vec<Value> = self
      .store
      .metadata
      .iter()
      .filter_map(|(h, md)| self.store.txids.get(*h as usize).map(|key| json!([txid_to_hex(*key), md])))
      .collect();

    let transactions: Vec<Value> = self
      .store
      .transactions
      .iter()
      .filter_map(|(h, tx)| self.store.txids.get(*h as usize).map(|key| json!([txid_to_hex(*key), tx])))
      .collect();

    let load_tracker: Vec<Value> = self
      .store
      .load_tracker
      .iter()
      .filter_map(|(h, info)| self.store.txids.get(*h as usize).map(|key| json!([txid_to_hex(*key), info])))
      .collect();

    json!({
      "version": 2,
      "txids": txids,
      "providerTx": provider_tx,
      "metadata": metadata,
      "transactions": transactions,
      "loadTracker": load_tracker,
    })
  }

  #[napi(js_name = "importSnapshot")]
  pub fn import_snapshot(&mut self, state: Value) -> Result<()> {
    if state.is_null() {
      self.store.clear();
      return Ok(());
    }

    ensure_snapshot_v2(&state)?;
    self.store.clear();

    if state == empty_snapshot() {
      return Ok(());
    }

    if let Some(Value::Array(txids)) = state.get("txids") {
      for txid in txids.iter().filter_map(Value::as_str) {
        if let Some(key) = parse_txid(txid) {
          self.store.ensure_handle(key);
        }
      }
    }

    if let Some(Value::Array(entries)) = state.get("providerTx") {
      for entry in entries {
        let Value::Array(pair) = entry else {
          continue;
        };
        if pair.len() != 2 {
          continue;
        }

        let provider = pair[0].as_str().unwrap_or_default().to_string();
        if provider.is_empty() {
          continue;
        }

        let mut handles = Vec::new();

        if let Value::Array(ids) = &pair[1] {
          for txid in ids.iter().filter_map(Value::as_str) {
            if let Some(key) = parse_txid(txid) {
              handles.push(self.store.ensure_handle(key));
            }
          }
        }

        if !handles.is_empty() {
          self.store.provider_tx.insert(provider, handles);
        }
      }
    }

    if let Some(Value::Array(entries)) = state.get("metadata") {
      for entry in entries {
        self.store.import_pair(entry, PairTarget::Metadata);
      }
    }

    if let Some(Value::Array(entries)) = state.get("transactions") {
      for entry in entries {
        self.store.import_pair(entry, PairTarget::Transaction);
      }
    }

    if let Some(Value::Array(entries)) = state.get("loadTracker") {
      for entry in entries {
        self.store.import_pair(entry, PairTarget::LoadTracker);
      }
    }

    Ok(())
  }

  /// Explicitly clears only the native backing store. Domain reset/rollback decisions
  /// must still be made by the TS aggregate/event-store layer.
  #[napi]
  pub fn clear(&mut self) {
    self.store.clear();
  }

  /// Releases native memory held by the backing store.
  ///
  /// This is a lifecycle/cleanup hook called by the TS owner when the aggregate
  /// is no longer used. It does not emit events, does not affect persistence and
  /// does not unload the `.node` addon itself; it only drops/shrinks Rust data
  /// structures owned by this state store instance.
  #[napi]
  pub fn dispose(&mut self) {
    self.store.dispose();
  }

  #[napi(js_name = "assertStoreOnly")]
  pub fn assert_store_only(&self) -> bool {
    true
  }
}
