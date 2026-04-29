use serde_json::Value;

pub fn cleanup_block_hex(value: &mut Value) {
  if let Value::Object(block) = value {
    block.remove("hex");

    if let Some(Value::Array(txs)) = block.get_mut("tx") {
      for tx in txs {
        if let Value::Object(obj) = tx {
          obj.remove("hex");
        }
      }
    }
  }
}
