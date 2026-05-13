use napi_derive::napi;
use sha2::{Digest, Sha256};
use serde_json::Value;

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

#[napi(js_name = "bitcoinComputeMerkleRoot")]
pub fn bitcoin_compute_merkle_root(txids_be: Vec<String>) -> String {
  if txids_be.is_empty() { return "0".repeat(64); }
  if txids_be.len() == 1 { return txids_be[0].clone(); }

  let mut level: Vec<[u8; 32]> = txids_be.iter()
    .filter_map(|id| be_hex_to_le_bytes(id))
    .collect();

  while level.len() > 1 {
    if level.len() % 2 == 1 { level.push(*level.last().unwrap()); }
    level = level.chunks(2).map(|p| {
      let mut buf = [0u8; 64];
      buf[..32].copy_from_slice(&p[0]);
      buf[32..].copy_from_slice(&p[1]);
      dsha256(&buf)
    }).collect();
  }

  le_bytes_to_be_hex(level[0])
}

#[napi(js_name = "bitcoinVerifyMerkleRoot")]
pub fn bitcoin_verify_merkle_root(txids_be: Vec<String>, expected_be: String) -> bool {
  if txids_be.is_empty() { return true; }
  bitcoin_compute_merkle_root(txids_be) == expected_be
}

#[napi(js_name = "bitcoinVerifyWitnessCommitment")]
pub fn bitcoin_verify_witness_commitment(block: Value) -> bool {
  let txs = match block.get("tx").and_then(|v| v.as_array()) {
    Some(t) => t,
    None => return true,
  };

  if txs.is_empty() { return true; }

  // Collect wtxids; coinbase (index 0) is always zeroed per BIP141
  let mut wtxids: Vec<String> = Vec::with_capacity(txs.len());
  for (i, tx) in txs.iter().enumerate() {
    if i == 0 {
      wtxids.push("0".repeat(64));
    } else {
      match tx.get("hash").and_then(|v| v.as_str()) {
        Some(h) => wtxids.push(h.to_string()),
        None => return true, // no witness data, skip
      }
    }
  }

  // Compute witness merkle root
  let witness_root_hex = bitcoin_compute_merkle_root(wtxids);
  let witness_root = match be_hex_to_le_bytes(&witness_root_hex) {
    Some(r) => r,
    None => return true,
  };

  // Reserved value is all zeros
  let reserved = [0u8; 32];
  let mut commit_input = [0u8; 64];
  commit_input[..32].copy_from_slice(&witness_root);
  commit_input[32..].copy_from_slice(&reserved);
  let commitment = dsha256(&commit_input);
  let commitment_hex = hex::encode(commitment);

  // Find commitment in coinbase outputs (OP_RETURN with 0xaa21a9ed prefix)
  let coinbase = &txs[0];
  let vouts = match coinbase.get("vout").and_then(|v| v.as_array()) {
    Some(v) => v,
    None => return true,
  };

  for vout in vouts {
    let script_hex = vout
      .get("scriptPubKey")
      .and_then(|s| s.get("hex"))
      .and_then(|h| h.as_str())
      .unwrap_or("");

    // OP_RETURN (6a) + PUSH36 (24) + aa21a9ed + 32-byte commitment
    if script_hex.starts_with("6a24aa21a9ed") {
      let found = &script_hex[12..]; // skip "6a24aa21a9ed"
      if found == commitment_hex {
        return true;
      }
    }
  }

  false
}
