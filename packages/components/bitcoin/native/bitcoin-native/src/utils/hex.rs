#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TxKey(pub [u8; 32]);

pub fn parse_txid(txid: &str) -> Option<TxKey> {
  if txid.len() != 64 {
    return None;
  }

  let mut out = [0u8; 32];
  for (i, chunk) in txid.as_bytes().chunks(2).enumerate() {
    let hi = (chunk[0] as char).to_digit(16)? as u8;
    let lo = (chunk[1] as char).to_digit(16)? as u8;
    out[i] = (hi << 4) | lo;
  }

  Some(TxKey(out))
}

pub fn txid_to_hex(key: TxKey) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut s = String::with_capacity(64);

  for b in key.0 {
    s.push(HEX[(b >> 4) as usize] as char);
    s.push(HEX[(b & 0x0f) as usize] as char);
  }

  s
}
