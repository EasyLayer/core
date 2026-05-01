#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct HashKey(pub [u8; 32]);

pub fn parse_hash(hash: &str) -> Option<HashKey> {
  let value = hash.strip_prefix("0x").or_else(|| hash.strip_prefix("0X")).unwrap_or(hash);
  if value.len() != 64 {
    return None;
  }

  let mut out = [0u8; 32];
  for (i, chunk) in value.as_bytes().chunks(2).enumerate() {
    let hi = (chunk[0] as char).to_digit(16)? as u8;
    let lo = (chunk[1] as char).to_digit(16)? as u8;
    out[i] = (hi << 4) | lo;
  }

  Some(HashKey(out))
}

pub fn hash_to_hex(key: HashKey) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut s = String::with_capacity(66);
  s.push_str("0x");
  for b in key.0 {
    s.push(HEX[(b >> 4) as usize] as char);
    s.push(HEX[(b & 0x0f) as usize] as char);
  }
  s
}
