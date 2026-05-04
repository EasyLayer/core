use napi::{Error, Result};
use napi_derive::napi;
use serde_json::Value;
use std::collections::HashMap;

use crate::utils::{number_field, string_field};

#[derive(Clone)]
struct BlockEntry {
  value: Value,
  block_number: i64,
  hash: String,
  size: u64,
}

#[napi]
pub struct NativeBlocksQueue {
  last_height: i64,
  max_queue_size: u64,
  block_size: u64,
  max_block_height: i64,
  size: u64,
  blocks: Vec<Option<BlockEntry>>,
  head_index: usize,
  tail_index: usize,
  current_block_count: usize,
  block_number_index: HashMap<i64, usize>,
  hash_index: HashMap<String, usize>,
}

fn cleanup_hex(value: &mut Value) {
  if let Value::Object(block) = value {
    block.remove("hex");
    if let Some(Value::Array(transactions)) = block.get_mut("transactions") {
      for tx in transactions {
        if let Value::Object(tx_obj) = tx {
          tx_obj.remove("hex");
        }
      }
    }
  }
}

fn block_number_of(block: &Value) -> Result<i64> {
  number_field(block, "blockNumber")
    .map(|v| v as i64)
    .ok_or_else(|| Error::from_reason("Block is missing numeric blockNumber"))
}

fn block_hash_of(block: &Value) -> Result<String> {
  string_field(block, "hash")
    .map(ToOwned::to_owned)
    .ok_or_else(|| Error::from_reason("Block is missing string hash"))
}

fn block_size_of(block: &Value) -> Result<u64> {
  number_field(block, "size")
    .map(|v| v.max(0.0) as u64)
    .ok_or_else(|| Error::from_reason("Block is missing numeric size"))
}

#[napi]
impl NativeBlocksQueue {
  #[napi(constructor)]
  pub fn new(options: Value) -> Result<Self> {
    let last_height = number_field(&options, "lastHeight").unwrap_or(-1.0) as i64;
    let max_queue_size = number_field(&options, "maxQueueSize").unwrap_or(128.0 * 1024.0 * 1024.0) as u64;
    let block_size = number_field(&options, "blockSize").unwrap_or(256.0 * 1024.0) as u64;
    let max_block_height = number_field(&options, "maxBlockHeight").unwrap_or(i64::MAX as f64) as i64;
    let min_block_size = 1024u64;
    let slots = std::cmp::max(2, (max_queue_size / std::cmp::max(min_block_size, 1)) as usize);

    Ok(Self {
      last_height,
      max_queue_size,
      block_size,
      max_block_height,
      size: 0,
      blocks: vec![None; slots],
      head_index: 0,
      tail_index: 0,
      current_block_count: 0,
      block_number_index: HashMap::new(),
      hash_index: HashMap::new(),
    })
  }

  #[napi(js_name = "isQueueFull")]
  pub fn is_queue_full(&self) -> bool {
    self.size >= self.max_queue_size
  }

  #[napi(js_name = "isQueueOverloaded")]
  pub fn is_queue_overloaded(&self, additional_size: f64) -> bool {
    self.size.saturating_add(additional_size.max(0.0) as u64) > self.max_queue_size
  }

  #[napi(js_name = "getBlockSize")]
  pub fn get_block_size(&self) -> f64 {
    self.block_size as f64
  }

  #[napi(js_name = "setBlockSize")]
  pub fn set_block_size(&mut self, size: f64) {
    self.block_size = size.max(0.0) as u64;
  }

  #[napi(js_name = "isMaxHeightReached")]
  pub fn is_max_height_reached(&self) -> bool {
    self.last_height >= self.max_block_height
  }

  #[napi(js_name = "getMaxBlockHeight")]
  pub fn get_max_block_height(&self) -> f64 {
    self.max_block_height as f64
  }

  #[napi(js_name = "setMaxBlockHeight")]
  pub fn set_max_block_height(&mut self, height: f64) {
    self.max_block_height = height as i64;
  }

  #[napi(js_name = "getMaxQueueSize")]
  pub fn get_max_queue_size(&self) -> f64 {
    self.max_queue_size as f64
  }

  #[napi(js_name = "setMaxQueueSize")]
  pub fn set_max_queue_size(&mut self, size: f64) {
    self.max_queue_size = size.max(0.0) as u64;
  }

  #[napi(js_name = "getCurrentSize")]
  pub fn get_current_size(&self) -> f64 {
    self.size as f64
  }

  #[napi(js_name = "getLength")]
  pub fn get_length(&self) -> f64 {
    self.current_block_count as f64
  }

  #[napi(js_name = "getLastHeight")]
  pub fn get_last_height(&self) -> f64 {
    self.last_height as f64
  }

  #[napi(js_name = "firstBlock")]
  pub fn first_block(&self) -> Option<Value> {
    if self.current_block_count == 0 {
      return None;
    }
    self.blocks.get(self.head_index).and_then(|b| b.as_ref().map(|entry| entry.value.clone()))
  }

  #[napi(js_name = "validateEnqueue")]
  pub fn validate_enqueue(&self, meta: Value) -> Result<()> {
    let block_number = number_field(&meta, "blockNumber").ok_or_else(|| Error::from_reason("Missing blockNumber"))? as i64;
    let size = number_field(&meta, "size").ok_or_else(|| Error::from_reason("Missing size"))? as u64;
    let hash = string_field(&meta, "hash").ok_or_else(|| Error::from_reason("Missing hash"))?;

    if self.hash_index.contains_key(hash) {
      return Err(Error::from_reason("Duplicate block hash"));
    }
    if block_number != self.last_height + 1 {
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Block number: {}, Queue last height: {}",
        block_number, self.last_height
      )));
    }
    if self.is_max_height_reached() {
      return Err(Error::from_reason(format!("Can't enqueue block. Max height reached: {}", self.max_block_height)));
    }
    if self.size + size > self.max_queue_size {
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Would exceed memory limit: {}/{} bytes",
        self.size + size,
        self.max_queue_size
      )));
    }
    Ok(())
  }

  #[napi(js_name = "enqueueCleaned")]
  pub fn enqueue_cleaned(&mut self, block: Value) -> Result<()> {
    self.enqueue_inner(block, false)
  }

  #[napi]
  pub fn enqueue(&mut self, mut block: Value) -> Result<()> {
    cleanup_hex(&mut block);
    self.enqueue_inner(block, false)
  }

  #[napi]
  pub fn dequeue(&mut self, hash_or_hashes: Value) -> Result<f64> {
    let hashes: Vec<String> = match hash_or_hashes {
      Value::String(hash) => vec![hash],
      Value::Array(items) => items.into_iter().filter_map(|item| item.as_str().map(ToOwned::to_owned)).collect(),
      _ => vec![],
    };

    let mut last = self.last_height;
    for hash in hashes {
      let index = self.hash_index.get(&hash).copied().ok_or_else(|| Error::from_reason(format!("Block not found: {}", hash)))?;
      if index != self.head_index {
        return Err(Error::from_reason(format!("Block not at head of queue: {}", hash)));
      }

      let entry = self.blocks[self.head_index].take().ok_or_else(|| Error::from_reason(format!("Block data corrupted: {}", hash)))?;
      self.block_number_index.remove(&entry.block_number);
      self.hash_index.remove(&entry.hash);
      self.head_index = (self.head_index + 1) % self.blocks.len();
      self.current_block_count -= 1;
      self.size = self.size.saturating_sub(entry.size);
      last = entry.block_number;
    }

    Ok(last as f64)
  }

  #[napi(js_name = "fetchBlockFromInStack")]
  pub fn fetch_block_from_in_stack(&self, height: f64) -> Option<Value> {
    let index = self.block_number_index.get(&(height as i64)).copied()?;
    self.blocks.get(index).and_then(|b| b.as_ref().map(|entry| entry.value.clone()))
  }

  #[napi(js_name = "fetchBlockFromOutStack")]
  pub fn fetch_block_from_out_stack(&self, height: f64) -> Option<Value> {
    self.fetch_block_from_in_stack(height)
  }

  #[napi(js_name = "findBlocks")]
  pub fn find_blocks(&self, hashes: Vec<String>) -> Vec<Value> {
    let mut out = Vec::new();
    for hash in hashes {
      if let Some(index) = self.hash_index.get(&hash) {
        if let Some(Some(entry)) = self.blocks.get(*index) {
          out.push(entry.value.clone());
        }
      }
    }
    out
  }

  #[napi(js_name = "getBatchUpToSize")]
  pub fn get_batch_up_to_size(&self, max_size: f64) -> Vec<Value> {
    if self.current_block_count == 0 {
      return Vec::new();
    }

    let mut out = Vec::new();
    let mut accumulated = 0u64;
    let mut index = self.head_index;
    let mut processed = 0usize;

    while processed < self.current_block_count {
      if let Some(Some(entry)) = self.blocks.get(index) {
        if accumulated + entry.size > max_size.max(0.0) as u64 {
          if out.is_empty() {
            out.push(entry.value.clone());
          }
          break;
        }
        accumulated += entry.size;
        out.push(entry.value.clone());
      }
      index = (index + 1) % self.blocks.len();
      processed += 1;
    }

    out
  }

  #[napi]
  pub fn clear(&mut self) {
    self.head_index = 0;
    self.tail_index = 0;
    self.current_block_count = 0;
    self.size = 0;
    for slot in &mut self.blocks {
      *slot = None;
    }
    self.block_number_index.clear();
    self.hash_index.clear();
  }

  #[napi]
  pub fn reorganize(&mut self, height: f64) {
    self.clear();
    self.last_height = height as i64;
  }

  #[napi(js_name = "getMemoryStats")]
  pub fn get_memory_stats(&self) -> Value {
    let indexes_size = self.block_number_index.len() + self.hash_index.len();
    serde_json::json!({
      "bufferAllocated": self.blocks.len(),
      "blocksUsed": self.current_block_count,
      "bufferEfficiency": if self.blocks.is_empty() { 0.0 } else { self.current_block_count as f64 / self.blocks.len() as f64 },
      "avgBlockSize": if self.current_block_count > 0 { self.size as f64 / self.current_block_count as f64 } else { 0.0 },
      "indexesSize": indexes_size,
      "memoryUsedBytes": self.size
    })
  }

  #[napi]
  pub fn dispose(&mut self) {
    self.clear();
    self.blocks.clear();
    self.blocks.shrink_to_fit();
    self.block_number_index.shrink_to_fit();
    self.hash_index.shrink_to_fit();
  }

  fn enqueue_inner(&mut self, block: Value, already_validated: bool) -> Result<()> {
    let block_number = block_number_of(&block)?;
    let hash = block_hash_of(&block)?;
    let size = block_size_of(&block)?;

    if !already_validated {
      self.validate_enqueue(serde_json::json!({ "blockNumber": block_number, "hash": hash.clone(), "size": size }))?;
    }

    if self.current_block_count >= self.blocks.len() {
      self.resize_ring(std::cmp::max(self.blocks.len() * 2, self.current_block_count + 1));
    }

    self.blocks[self.tail_index] = Some(BlockEntry { value: block, block_number, hash: hash.clone(), size });
    self.block_number_index.insert(block_number, self.tail_index);
    self.hash_index.insert(hash, self.tail_index);
    self.tail_index = (self.tail_index + 1) % self.blocks.len();
    self.current_block_count += 1;
    self.size += size;
    self.last_height = block_number;
    Ok(())
  }

  fn resize_ring(&mut self, new_capacity: usize) {
    if new_capacity == self.blocks.len() {
      return;
    }

    let mut new_blocks: Vec<Option<BlockEntry>> = vec![None; new_capacity];
    self.block_number_index.clear();
    self.hash_index.clear();

    let mut index = self.head_index;
    for i in 0..self.current_block_count {
      if let Some(entry) = self.blocks[index].take() {
        self.block_number_index.insert(entry.block_number, i);
        self.hash_index.insert(entry.hash.clone(), i);
        new_blocks[i] = Some(entry);
      }
      index = (index + 1) % self.blocks.len();
    }

    self.blocks = new_blocks;
    self.head_index = 0;
    self.tail_index = self.current_block_count % self.blocks.len();
  }
}
