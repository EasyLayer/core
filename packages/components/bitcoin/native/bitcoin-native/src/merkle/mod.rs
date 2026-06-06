use napi_derive::napi;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn dsha256(data: &[u8]) -> [u8; 32] {
  let first = Sha256::digest(data);
  Sha256::digest(&first).into()
}

fn be_hex_to_le_bytes(be_hex: &str) -> Option<[u8; 32]> {
  hex::decode(be_hex).ok().and_then(|mut b| {
    if b.len() == 32 {
      b.reverse();
      b.try_into().ok()
    } else {
      None
    }
  })
}

fn le_bytes_to_be_hex(le: [u8; 32]) -> String {
  let mut b = le;
  b.reverse();
  hex::encode(b)
}

fn json_hex_string(value: &Value, keys: &[&str]) -> Option<String> {
  if let Some(s) = value.as_str() {
    return (s.len() == 64).then(|| s.to_ascii_lowercase());
  }

  keys.iter().find_map(|key| {
    value
      .get(*key)
      .and_then(|v| v.as_str())
      .filter(|s| s.len() == 64)
      .map(|s| s.to_ascii_lowercase())
  })
}

fn witness_txid_for_index(tx: &Value, index: usize) -> Option<String> {
  if index == 0 {
    return Some("0".repeat(64));
  }

  // Bitcoin Core verbose transaction objects use `hash` for wtxid. EasyLayer
  // archive/reconstructed objects may carry explicit `wtxid`, so prefer it.
  json_hex_string(tx, &["wtxid", "hash", "txid"])
}

fn extract_witness_reserved_value(coinbase: &Value) -> [u8; 32] {
  let mut reserved = [0u8; 32];
  let witness = coinbase
    .get("vin")
    .and_then(|vin| vin.as_array())
    .and_then(|vin| vin.first())
    .and_then(|input| input.get("txinwitness"))
    .and_then(|w| w.as_array());

  if let Some(items) = witness {
    for item in items.iter().rev() {
      if let Some(s) = item.as_str() {
        if s.len() == 64 {
          if let Ok(decoded) = hex::decode(s) {
            if decoded.len() == 32 {
              reserved.copy_from_slice(&decoded);
              return reserved;
            }
          }
        }
      }
    }
  }

  reserved
}

fn extract_witness_commitment(coinbase: &Value) -> Option<String> {
  let vouts = coinbase.get("vout")?.as_array()?;

  for vout in vouts {
    let script_hex = vout
      .get("scriptPubKey")
      .and_then(|s| s.get("hex"))
      .and_then(|h| h.as_str())
      .unwrap_or("");

    // OP_RETURN (6a) + PUSH36 (24) + aa21a9ed + 32-byte commitment.
    if script_hex.starts_with("6a24aa21a9ed") && script_hex.len() >= 12 + 64 {
      return Some(script_hex[12..12 + 64].to_ascii_lowercase());
    }
  }

  None
}

#[napi(js_name = "bitcoinComputeMerkleRoot")]
pub fn bitcoin_compute_merkle_root(txids_be: Vec<String>) -> String {
  if txids_be.is_empty() {
    return "0".repeat(64);
  }
  if txids_be.len() == 1 {
    return txids_be[0].clone();
  }

  let mut level: Vec<[u8; 32]> = txids_be.iter().filter_map(|id| be_hex_to_le_bytes(id)).collect();

  while level.len() > 1 {
    if level.len() % 2 == 1 {
      level.push(*level.last().unwrap());
    }
    level = level
      .chunks(2)
      .map(|p| {
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&p[0]);
        buf[32..].copy_from_slice(&p[1]);
        dsha256(&buf)
      })
      .collect();
  }

  le_bytes_to_be_hex(level[0])
}

#[napi(js_name = "bitcoinVerifyMerkleRoot")]
pub fn bitcoin_verify_merkle_root(txids_be: Vec<String>, expected_be: String) -> bool {
  if txids_be.is_empty() {
    return expected_be == "0".repeat(64);
  }
  bitcoin_compute_merkle_root(txids_be).eq_ignore_ascii_case(&expected_be)
}

#[napi(js_name = "bitcoinVerifyWitnessCommitment")]
pub fn bitcoin_verify_witness_commitment(block: Value) -> bool {
  let txs = match block.get("tx").and_then(|v| v.as_array()) {
    Some(t) => t,
    None => return true,
  };

  if txs.is_empty() {
    return true;
  }

  let coinbase = &txs[0];
  let commitment_hex = match extract_witness_commitment(coinbase) {
    Some(c) => c,
    None => return true,
  };

  let mut wtxids: Vec<String> = Vec::with_capacity(txs.len());
  for (i, tx) in txs.iter().enumerate() {
    match witness_txid_for_index(tx, i) {
      Some(id) => wtxids.push(id),
      None => return false,
    }
  }

  let witness_root_hex = bitcoin_compute_merkle_root(wtxids);
  let witness_root = match be_hex_to_le_bytes(&witness_root_hex) {
    Some(r) => r,
    None => return false,
  };

  let reserved = extract_witness_reserved_value(coinbase);
  let mut commit_input = [0u8; 64];
  commit_input[..32].copy_from_slice(&witness_root);
  commit_input[32..].copy_from_slice(&reserved);
  let commitment = dsha256(&commit_input);
  let commitment_calc_hex = hex::encode(commitment);

  commitment_calc_hex.eq_ignore_ascii_case(&commitment_hex)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn dsha_hex(data: &[u8]) -> String {
    hex::encode(dsha256(data))
  }

  fn be_to_le(hex_be: &str) -> [u8; 32] {
    be_hex_to_le_bytes(hex_be).unwrap()
  }

  #[test]
  fn verify_witness_commitment_uses_zero_coinbase_and_wtxid_fields() {
    let wtxids = vec!["0".repeat(64), "88".repeat(32), "99".repeat(32)];
    let witness_root_be = bitcoin_compute_merkle_root(wtxids);
    let witness_root_le = be_to_le(&witness_root_be);
    let reserved = [0u8; 32];

    let mut input = [0u8; 64];
    input[..32].copy_from_slice(&witness_root_le);
    input[32..].copy_from_slice(&reserved);
    let commitment = dsha_hex(&input);

    let block = json!({
      "tx": [
        {
          "vin": [{ "txinwitness": ["aa", hex::encode(reserved)] }],
          "vout": [{ "scriptPubKey": { "hex": format!("6a24aa21a9ed{}", commitment) } }]
        },
        { "wtxid": "88".repeat(32) },
        { "wtxid": "99".repeat(32) }
      ]
    });

    assert!(bitcoin_verify_witness_commitment(block));
  }

  #[test]
  fn verify_witness_commitment_returns_false_when_required_wtxid_is_missing() {
    let block = json!({
      "tx": [
        {
          "vin": [{ "txinwitness": ["00".repeat(32)] }],
          "vout": [{ "scriptPubKey": { "hex": format!("6a24aa21a9ed{}", "11".repeat(32)) } }]
        },
        { "txid": null }
      ]
    });

    assert!(!bitcoin_verify_witness_commitment(block));
  }
}
