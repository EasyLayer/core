use napi::Result;
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::utils::{hash_to_hex, now_ms, parse_hash, HashKey};

fn nonce_key(from: &str, nonce: u64) -> String {
  format!("{}:{}", from.to_lowercase(), nonce)
}

fn metadata_nonce(metadata: &Value) -> Option<(String, u64)> {
  let from = metadata.get("from")?.as_str()?.to_lowercase();
  let nonce = metadata.get("nonce")?.as_u64()?;
  Some((from, nonce))
}

fn effective_gas_price(metadata: &Value) -> u128 {
  fn parse(value: Option<&Value>) -> u128 {
    value
      .and_then(Value::as_str)
      .and_then(|v| v.parse::<u128>().ok())
      .unwrap_or(0)
  }

  let max_fee = parse(metadata.get("maxFeePerGas"));
  if max_fee > 0 {
    return max_fee;
  }

  parse(metadata.get("gasPrice"))
}

fn convert_units(units: Option<String>) -> (&'static str, f64) {
  match units.as_deref().unwrap_or("MB") {
    "B" => ("B", 1.0),
    "KB" => ("KB", 1024.0),
    "GB" => ("GB", 1024.0 * 1024.0 * 1024.0),
    _ => ("MB", 1024.0 * 1024.0),
  }
}

#[derive(Default)]
struct EvmMempoolBackingStore {
  hash_to_handle: HashMap<HashKey, u32>,
  hashes: Vec<Option<HashKey>>,
  provider_tx: HashMap<String, Vec<u32>>,
  metadata: HashMap<u32, Value>,
  load_tracker: HashMap<u32, Value>,
  nonce_index: HashMap<String, u32>,
}

impl EvmMempoolBackingStore {
  fn clear(&mut self) {
    self.hash_to_handle.clear();
    self.hashes.clear();
    self.provider_tx.clear();
    self.metadata.clear();
    self.load_tracker.clear();
    self.nonce_index.clear();
  }

  fn dispose(&mut self) {
    self.clear();
    self.hash_to_handle.shrink_to_fit();
    self.hashes.shrink_to_fit();
    self.provider_tx.shrink_to_fit();
    self.metadata.shrink_to_fit();
    self.load_tracker.shrink_to_fit();
    self.nonce_index.shrink_to_fit();
  }

  fn ensure_handle(&mut self, key: HashKey) -> u32 {
    if let Some(handle) = self.hash_to_handle.get(&key) {
      return *handle;
    }
    let handle = self.hashes.len() as u32;
    self.hash_to_handle.insert(key, handle);
    self.hashes.push(Some(key));
    handle
  }

  fn handle_of_hash(&self, hash: &str) -> Option<u32> {
    parse_hash(hash).and_then(|key| self.hash_to_handle.get(&key).copied())
  }

  fn hash_of_handle(&self, handle: u32) -> Option<String> {
    self.hashes.get(handle as usize).and_then(|key| key.map(hash_to_hex))
  }

  fn add_provider_tx(&mut self, provider: String, handle: u32) {
    let list = self.provider_tx.entry(provider).or_default();
    if !list.contains(&handle) {
      list.push(handle);
    }
  }

  fn index_nonce(&mut self, metadata: &Value, handle: u32) {
    if let Some((from, nonce)) = metadata_nonce(metadata) {
      self.nonce_index.insert(nonce_key(&from, nonce), handle);
    }
  }

  fn remove_handle(&mut self, handle: u32) -> bool {
    let Some(key) = self.hashes.get(handle as usize).and_then(|key| *key) else {
      return false;
    };

    if let Some(metadata) = self.metadata.get(&handle) {
      if let Some((from, nonce)) = metadata_nonce(metadata) {
        let key = nonce_key(&from, nonce);
        if self.nonce_index.get(&key).copied() == Some(handle) {
          self.nonce_index.remove(&key);
        }
      }
    }

    self.hash_to_handle.remove(&key);
    if let Some(slot) = self.hashes.get_mut(handle as usize) {
      *slot = None;
    }
    self.metadata.remove(&handle);
    self.load_tracker.remove(&handle);
    for handles in self.provider_tx.values_mut() {
      handles.retain(|h| *h != handle);
    }
    true
  }

  fn evict_lowest_gas(&mut self) {
    let mut lowest: Option<(u32, u128)> = None;
    for (handle, metadata) in &self.metadata {
      let gas = effective_gas_price(metadata);
      if lowest.map(|(_, current)| gas < current).unwrap_or(true) {
        lowest = Some((*handle, gas));
      }
    }

    if let Some((handle, _)) = lowest {
      self.remove_handle(handle);
    }
  }
}

#[napi]
pub struct NativeEvmMempoolState {
  store: EvmMempoolBackingStore,
}

#[napi]
impl NativeEvmMempoolState {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self { store: EvmMempoolBackingStore::default() }
  }

  #[napi(js_name = "applySnapshot")]
  pub fn apply_snapshot(&mut self, per_provider: Value) -> Result<()> {
    let mut old_load: HashMap<HashKey, Value> = HashMap::new();
    for (handle, info) in &self.store.load_tracker {
      if let Some(key) = self.store.hashes.get(*handle as usize).and_then(|key| *key) {
        old_load.insert(key, info.clone());
      }
    }

    self.store.clear();
    let mut seen = HashSet::new();

    let Value::Object(providers) = per_provider else {
      return Ok(());
    };

    for (provider, items) in providers {
      let Value::Array(items) = items else { continue };
      for item in items {
        let Some(hash) = item.get("hash").and_then(Value::as_str) else { continue };
        let Some(key) = parse_hash(hash) else { continue };
        if !seen.insert(key) {
          continue;
        }
        let metadata = item.get("metadata").cloned().unwrap_or(Value::Null);
        let handle = self.store.ensure_handle(key);
        self.store.metadata.insert(handle, metadata.clone());
        self.store.add_provider_tx(provider.clone(), handle);
        self.store.index_nonce(&metadata, handle);
        if let Some(info) = old_load.get(&key) {
          self.store.load_tracker.insert(handle, info.clone());
        }
      }
    }

    Ok(())
  }

  #[napi(js_name = "addTransactions")]
  pub fn add_transactions(&mut self, per_provider: Value, max_pending_count: u32) -> Result<()> {
    let Value::Object(providers) = per_provider else {
      return Ok(());
    };

    for (provider, items) in providers {
      let Value::Array(items) = items else { continue };
      for item in items {
        let Some(hash) = item.get("hash").and_then(Value::as_str) else { continue };
        let Some(key) = parse_hash(hash) else { continue };
        if self.store.hash_to_handle.contains_key(&key) {
          continue;
        }
        if max_pending_count > 0 && self.store.hash_to_handle.len() >= max_pending_count as usize {
          self.store.evict_lowest_gas();
        }
        let metadata = item.get("metadata").cloned().unwrap_or(Value::Null);
        let handle = self.store.ensure_handle(key);
        self.store.metadata.insert(handle, metadata.clone());
        self.store.add_provider_tx(provider.clone(), handle);
        self.store.index_nonce(&metadata, handle);
      }
    }

    Ok(())
  }

  #[napi]
  pub fn providers(&self) -> Vec<String> {
    self.store.provider_tx.keys().cloned().collect()
  }

  #[napi(js_name = "pendingHashes")]
  pub fn pending_hashes(&self, provider_name: String, limit: u32) -> Vec<String> {
    let Some(handles) = self.store.provider_tx.get(&provider_name) else {
      return Vec::new();
    };

    let mut out = Vec::new();
    for handle in handles {
      if self.store.load_tracker.contains_key(handle) || !self.store.metadata.contains_key(handle) {
        continue;
      }
      if let Some(hash) = self.store.hash_of_handle(*handle) {
        out.push(hash);
      }
      if limit > 0 && out.len() >= limit as usize {
        break;
      }
    }
    out
  }

  #[napi(js_name = "recordLoaded")]
  pub fn record_loaded(&mut self, loaded_transactions: Value) -> Result<()> {
    let timestamp = now_ms();
    let Value::Array(items) = loaded_transactions else {
      return Ok(());
    };

    for item in items {
      let Some(hash) = item.get("hash").and_then(Value::as_str) else { continue };
      let Some(handle) = self.store.handle_of_hash(hash) else { continue };
      if self.store.load_tracker.contains_key(&handle) {
        continue;
      }
      let metadata = item.get("metadata").cloned().unwrap_or(Value::Null);
      let provider_name = item.get("providerName").and_then(Value::as_str).map(ToOwned::to_owned);
      let mut info = json!({
        "timestamp": timestamp,
        "effectiveGasPrice": effective_gas_price(&metadata).to_string()
      });
      if let Some(provider) = provider_name {
        if let Value::Object(ref mut map) = info {
          map.insert("providerName".to_string(), Value::String(provider));
        }
      }
      self.store.load_tracker.insert(handle, info);
    }

    Ok(())
  }

  #[napi(js_name = "removeHash")]
  pub fn remove_hash(&mut self, hash: String) -> bool {
    let Some(handle) = self.store.handle_of_hash(&hash) else {
      return false;
    };
    self.store.remove_handle(handle)
  }

  #[napi(js_name = "removeHashes")]
  pub fn remove_hashes(&mut self, hashes: Vec<String>) -> u32 {
    let mut removed = 0;
    for hash in hashes {
      if self.remove_hash(hash) {
        removed += 1;
      }
    }
    removed
  }

  #[napi(js_name = "getReplacementCandidate")]
  pub fn get_replacement_candidate(&self, from: String, nonce: u32) -> Option<Value> {
    let handle = self.store.nonce_index.get(&nonce_key(&from, nonce as u64)).copied()?;
    let hash = self.store.hash_of_handle(handle)?;
    let metadata = self.store.metadata.get(&handle)?.clone();
    Some(json!({ "hash": hash, "metadata": metadata }))
  }

  #[napi]
  pub fn hashes(&self) -> Vec<String> {
    self.store.hashes.iter().filter_map(|key| key.map(hash_to_hex)).collect()
  }

  #[napi]
  pub fn metadata(&self) -> Vec<Value> {
    self.store.metadata.values().cloned().collect()
  }

  #[napi(js_name = "hasTransaction")]
  pub fn has_transaction(&self, hash: String) -> bool {
    self.store.handle_of_hash(&hash).is_some()
  }

  #[napi(js_name = "isTransactionLoaded")]
  pub fn is_transaction_loaded(&self, hash: String) -> bool {
    self.store
      .handle_of_hash(&hash)
      .map(|handle| self.store.load_tracker.contains_key(&handle))
      .unwrap_or(false)
  }

  #[napi(js_name = "getTransactionMetadata")]
  pub fn get_transaction_metadata(&self, hash: String) -> Option<Value> {
    let handle = self.store.handle_of_hash(&hash)?;
    self.store.metadata.get(&handle).cloned()
  }

  #[napi(js_name = "getStats")]
  pub fn get_stats(&self) -> Value {
    json!({
      "total": self.store.hash_to_handle.len(),
      "loaded": self.store.load_tracker.len(),
      "providers": self.store.provider_tx.len(),
      "nonceIndex": self.store.nonce_index.len()
    })
  }

  #[napi(js_name = "pruneTtl")]
  pub fn prune_ttl(&mut self, ttl_ms: u32, now_ms_arg: Option<f64>) -> u32 {
    if ttl_ms == 0 {
      return 0;
    }
    let now = now_ms_arg.map(|v| v.max(0.0) as u64).unwrap_or_else(now_ms);
    let cutoff = now.saturating_sub(ttl_ms as u64);
    let mut to_remove = Vec::new();

    for (handle, info) in &self.store.load_tracker {
      let timestamp = info.get("timestamp").and_then(Value::as_u64).unwrap_or(0);
      if timestamp < cutoff {
        if let Some(hash) = self.store.hash_of_handle(*handle) {
          to_remove.push(hash);
        }
      }
    }

    self.remove_hashes(to_remove)
  }

  #[napi(js_name = "getMemoryUsage")]
  pub fn get_memory_usage(&self, units: Option<String>) -> Value {
    let (unit, div) = convert_units(units);
    let hash_index = self.store.hash_to_handle.len() * (32 + 16);
    let metadata = self.store.metadata.len() * 256;
    let load_tracker = self.store.load_tracker.len() * 64;
    let provider_tx = self.store.provider_tx.values().map(|v| v.len() * 4).sum::<usize>();
    let nonce_index = self.store.nonce_index.len() * 56;
    let total = hash_index + metadata + load_tracker + provider_tx + nonce_index;

    json!({
      "unit": unit,
      "counts": {
        "hashes": self.store.hash_to_handle.len(),
        "metadata": self.store.metadata.len(),
        "loaded": self.store.load_tracker.len(),
        "providers": self.store.provider_tx.len(),
        "nonceIndex": self.store.nonce_index.len()
      },
      "bytes": {
        "hashIndex": hash_index as f64 / div,
        "metadata": metadata as f64 / div,
        "loadTracker": load_tracker as f64 / div,
        "providerTx": provider_tx as f64 / div,
        "nonceIndex": nonce_index as f64 / div,
        "total": total as f64 / div
      }
    })
  }

  #[napi(js_name = "exportSnapshot")]
  pub fn export_snapshot(&self) -> Value {
    let hashes: Vec<String> = self.store.hashes.iter().filter_map(|key| key.map(hash_to_hex)).collect();

    let provider_tx: Vec<Value> = self
      .store
      .provider_tx
      .iter()
      .map(|(provider, handles)| {
        let hashes: Vec<String> = handles.iter().filter_map(|handle| self.store.hash_of_handle(*handle)).collect();
        json!([provider, hashes])
      })
      .collect();

    let metadata: Vec<Value> = self
      .store
      .metadata
      .iter()
      .filter_map(|(handle, metadata)| self.store.hash_of_handle(*handle).map(|hash| json!([hash, metadata])))
      .collect();

    let load_tracker: Vec<Value> = self
      .store
      .load_tracker
      .iter()
      .filter_map(|(handle, info)| self.store.hash_of_handle(*handle).map(|hash| json!([hash, info])))
      .collect();

    let nonce_index: Vec<Value> = self
      .store
      .nonce_index
      .iter()
      .filter_map(|(key, handle)| self.store.hash_of_handle(*handle).map(|hash| json!([key, hash])))
      .collect();

    json!({
      "version": 2,
      "hashes": hashes,
      "providerTx": provider_tx,
      "metadata": metadata,
      "loadTracker": load_tracker,
      "nonceIndex": nonce_index
    })
  }

  #[napi(js_name = "importSnapshot")]
  pub fn import_snapshot(&mut self, state: Value) -> Result<()> {
    self.store.clear();

    let hashes = state.get("hashes").and_then(Value::as_array).cloned().unwrap_or_default();
    for hash in hashes {
      if let Some(hash) = hash.as_str() {
        if let Some(key) = parse_hash(hash) {
          self.store.ensure_handle(key);
        }
      }
    }

    if let Some(entries) = state.get("metadata").and_then(Value::as_array) {
      for entry in entries {
        let Some(pair) = entry.as_array() else { continue };
        if pair.len() != 2 { continue; }
        let Some(hash) = pair[0].as_str() else { continue };
        let Some(key) = parse_hash(hash) else { continue };
        let handle = self.store.ensure_handle(key);
        let metadata = pair[1].clone();
        self.store.metadata.insert(handle, metadata.clone());
        self.store.index_nonce(&metadata, handle);
      }
    }

    if let Some(entries) = state.get("providerTx").and_then(Value::as_array) {
      for entry in entries {
        let Some(pair) = entry.as_array() else { continue };
        if pair.len() != 2 { continue; }
        let Some(provider) = pair[0].as_str() else { continue };
        let Some(hashes) = pair[1].as_array() else { continue };
        for hash in hashes {
          let Some(hash) = hash.as_str() else { continue };
          let Some(key) = parse_hash(hash) else { continue };
          let handle = self.store.ensure_handle(key);
          self.store.add_provider_tx(provider.to_string(), handle);
        }
      }
    }

    if let Some(entries) = state.get("loadTracker").and_then(Value::as_array) {
      for entry in entries {
        let Some(pair) = entry.as_array() else { continue };
        if pair.len() != 2 { continue; }
        let Some(hash) = pair[0].as_str() else { continue };
        let Some(handle) = self.store.handle_of_hash(hash) else { continue };
        self.store.load_tracker.insert(handle, pair[1].clone());
      }
    }

    if let Some(entries) = state.get("nonceIndex").and_then(Value::as_array) {
      for entry in entries {
        let Some(pair) = entry.as_array() else { continue };
        if pair.len() != 2 { continue; }
        let Some(key) = pair[0].as_str() else { continue };
        let Some(hash) = pair[1].as_str() else { continue };
        let Some(handle) = self.store.handle_of_hash(hash) else { continue };
        self.store.nonce_index.insert(key.to_lowercase(), handle);
      }
    }

    Ok(())
  }

  #[napi]
  pub fn dispose(&mut self) {
    self.store.dispose();
  }
}
