use serde_json::Value;

pub fn number_field(value: &Value, key: &str) -> Option<f64> {
  value.get(key).and_then(Value::as_f64)
}

pub fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str)
}
