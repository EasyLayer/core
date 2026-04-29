use napi::{Error, Result};
use serde_json::Value;

/// Validates the only supported mempool snapshot shape.
///
/// There is intentionally no legacy hash32 migration here: the TS aggregate/store layer
/// owns domain compatibility decisions. Native code only stores the current txid-based
/// backing state used by the Mempool aggregate.
pub fn ensure_snapshot_v2(state: &Value) -> Result<()> {
  if state.is_null() {
    return Ok(());
  }

  let is_v2 = state.get("version").and_then(Value::as_i64) == Some(2);
  let has_current_shape = state.get("providerTx").is_some()
    || state.get("txids").is_some()
    || state.get("metadata").is_some()
    || state.get("transactions").is_some()
    || state.get("loadTracker").is_some();

  if is_v2 || has_current_shape {
    Ok(())
  } else {
    Err(Error::from_reason(
      "Unsupported mempool snapshot format. Native mempool store accepts only txid-based version 2 snapshots.",
    ))
  }
}

pub fn empty_snapshot() -> Value {
  serde_json::json!({
    "version": 2,
    "txids": [],
    "providerTx": [],
    "metadata": [],
    "transactions": [],
    "loadTracker": [],
  })
}
