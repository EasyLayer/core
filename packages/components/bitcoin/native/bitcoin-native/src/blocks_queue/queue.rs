use napi::{bindgen_prelude::Buffer, Error, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::utils::{now_ms, number_field, string_field};

use super::planner::CapacityPlanner;

#[derive(Clone)]
struct BlockEntry {
  bytes: Buffer,
  height: i64,
  hash: String,
  size: u64,
}

#[napi(object)]
pub struct NativeRawBlock {
  pub hash: String,
  pub height: f64,
  pub size: f64,
  pub bytes: Buffer,
}

#[napi]
pub struct NativeBlocksQueue {
  last_height: i64,
  max_queue_size: u64,
  block_size: u64,
  size: u64,
  max_block_height: i64,
  planner: CapacityPlanner,
  blocks: Vec<Option<BlockEntry>>,
  head_index: usize,
  tail_index: usize,
  current_block_count: usize,
  height_index: HashMap<i64, usize>,
  hash_index: HashMap<String, usize>,
}

#[napi]
impl NativeBlocksQueue {
  #[napi(constructor)]
  pub fn new(options: Value) -> Result<Self> {
    let last_height = number_field(&options, "lastHeight").unwrap_or(-1.0) as i64;
    let max_queue_size = number_field(&options, "maxQueueSize").unwrap_or(0.0).max(0.0) as u64;
    let block_size = number_field(&options, "blockSize").unwrap_or(1.0).max(1.0) as u64;
    let max_block_height = number_field(&options, "maxBlockHeight").unwrap_or(i64::MAX as f64) as i64;
    let planner_config = options.get("plannerConfig");
    let planner = CapacityPlanner::new(block_size as f64, planner_config);
    let initial_slots = planner.desired_slots(max_queue_size).max(2);

    Ok(Self {
      last_height,
      max_queue_size,
      block_size,
      size: 0,
      max_block_height,
      planner,
      blocks: vec![None; initial_slots],
      head_index: 0,
      tail_index: 0,
      current_block_count: 0,
      height_index: HashMap::new(),
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
  pub fn get_block_size(&self) -> f64 { self.block_size as f64 }

  #[napi(js_name = "setBlockSize")]
  pub fn set_block_size(&mut self, size: f64) { self.block_size = size.max(0.0) as u64; }

  #[napi(js_name = "isMaxHeightReached")]
  pub fn is_max_height_reached(&self) -> bool { self.last_height >= self.max_block_height }

  #[napi(js_name = "getMaxBlockHeight")]
  pub fn get_max_block_height(&self) -> f64 { self.max_block_height as f64 }

  #[napi(js_name = "setMaxBlockHeight")]
  pub fn set_max_block_height(&mut self, height: f64) { self.max_block_height = height as i64; }

  #[napi(js_name = "getMaxQueueSize")]
  pub fn get_max_queue_size(&self) -> f64 { self.max_queue_size as f64 }

  #[napi(js_name = "setMaxQueueSize")]
  pub fn set_max_queue_size(&mut self, size: f64) { self.max_queue_size = size.max(0.0) as u64; }

  #[napi(js_name = "getCurrentSize")]
  pub fn get_current_size(&self) -> f64 { self.size as f64 }

  #[napi(js_name = "getLength")]
  pub fn get_length(&self) -> f64 { self.current_block_count as f64 }

  #[napi(js_name = "getLastHeight")]
  pub fn get_last_height(&self) -> f64 { self.last_height as f64 }

  #[napi(js_name = "validateEnqueue")]
  pub fn validate_enqueue(&self, meta: Value) -> Result<()> {
    let hash = string_field(&meta, "hash").ok_or_else(|| Error::from_reason("Block hash is required"))?;
    let height = number_field(&meta, "height").ok_or_else(|| Error::from_reason("Block height is required"))? as i64;
    let size = number_field(&meta, "size").ok_or_else(|| Error::from_reason("Block size is required"))?.max(0.0) as u64;
    self.validate_enqueue_parts(hash, height, size)
  }

  #[napi(js_name = "enqueueBytes")]
  pub fn enqueue_bytes(&mut self, hash: String, height: f64, size: f64, bytes: Buffer) -> Result<()> {
    let h = height as i64;
    let s = size.max(0.0) as u64;

    self.validate_enqueue_parts(&hash, h, s)?;
    self.maybe_resize_for_enqueue(s)?;

    let owned_bytes: Buffer = bytes.as_ref().to_vec().into();
    self.blocks[self.tail_index] = Some(BlockEntry { bytes: owned_bytes, height: h, hash: hash.clone(), size: s });
    self.height_index.insert(h, self.tail_index);
    self.hash_index.insert(hash, self.tail_index);
    self.tail_index = (self.tail_index + 1) % self.blocks.len();
    self.current_block_count += 1;
    self.size += s;
    self.last_height = h;

    Ok(())
  }

  #[napi(js_name = "getBatchUpToSize")]
  pub fn get_batch_up_to_size(&self, max_size: f64) -> Vec<NativeRawBlock> {
    let entries = self.collect_batch_entries(max_size);
    entries.into_iter().map(Self::entry_to_raw_block).collect()
  }

  #[napi(js_name = "findBlocks")]
  pub fn find_blocks(&self, hashes: Vec<String>) -> Vec<NativeRawBlock> {
    hashes.iter()
      .filter_map(|hash| {
        self.hash_index.get(hash)
          .and_then(|idx| self.blocks.get(*idx))
          .and_then(|entry| entry.as_ref())
          .map(Self::entry_to_raw_block)
      })
      .collect()
  }

  #[napi(js_name = "getBlockBytes")]
  pub fn get_block_bytes(&self, hash: String) -> Option<Buffer> {
    self.hash_index.get(&hash)
      .and_then(|idx| self.blocks.get(*idx))
      .and_then(|entry| entry.as_ref())
      .map(|entry| entry.bytes.clone())
  }

  #[napi(js_name = "getBatchMetaUpToSize")]
  pub fn get_batch_meta_up_to_size(&self, max_size: f64) -> Vec<Value> {
    self.collect_batch_entries(max_size)
      .into_iter()
      .map(|entry| json!({ "hash": entry.hash, "height": entry.height, "size": entry.size }))
      .collect()
  }

  #[napi]
  pub fn dequeue(&mut self, hash_or_hashes: Value) -> Result<f64> {
    let hashes: Vec<String> = if let Some(s) = hash_or_hashes.as_str() {
      vec![s.to_string()]
    } else if let Some(arr) = hash_or_hashes.as_array() {
      arr.iter().filter_map(Value::as_str).map(ToString::to_string).collect()
    } else {
      return Err(Error::from_reason("Expected block hash or hashes"));
    };

    let mut height = 0_i64;
    for hash in hashes {
      let idx = self.hash_index.get(&hash).copied()
        .ok_or_else(|| Error::from_reason(format!("Block not found: {}", hash)))?;
      if idx != self.head_index {
        return Err(Error::from_reason(format!("Block not at head of queue: {}", hash)));
      }
      let entry = self.blocks[self.head_index].take()
        .ok_or_else(|| Error::from_reason(format!("Block data corrupted: {}", hash)))?;
      self.height_index.remove(&entry.height);
      self.hash_index.remove(&entry.hash);
      self.head_index = (self.head_index + 1) % self.blocks.len();
      self.current_block_count -= 1;
      self.size = self.size.saturating_sub(entry.size);
      height = entry.height;
    }

    Ok(height as f64)
  }

  #[napi]
  pub fn clear(&mut self) {
    self.head_index = 0;
    self.tail_index = 0;
    self.current_block_count = 0;
    self.size = 0;
    for slot in &mut self.blocks { *slot = None; }
    self.height_index.clear();
    self.hash_index.clear();
  }

  #[napi]
  pub fn reorganize(&mut self, height: f64) {
    self.clear();
    self.last_height = height as i64;
  }

  #[napi]
  pub fn dispose(&mut self) {
    self.clear();
    self.blocks.clear();
    self.blocks.shrink_to_fit();
    self.height_index.shrink_to_fit();
    self.hash_index.shrink_to_fit();
    self.head_index = 0;
    self.tail_index = 0;
  }

  #[napi(js_name = "getMemoryStats")]
  pub fn get_memory_stats(&self) -> Value {
    let indexes_size = self.height_index.len() + self.hash_index.len();
    json!({
      "bufferAllocated": self.blocks.len(),
      "blocksUsed": self.current_block_count,
      "bufferEfficiency": if self.blocks.is_empty() { 0.0 } else { self.current_block_count as f64 / self.blocks.len() as f64 },
      "avgBlockSize": if self.current_block_count > 0 { self.size as f64 / self.current_block_count as f64 } else { 0.0 },
      "indexesSize": indexes_size,
      "memoryUsedBytes": self.size,
    })
  }

  fn validate_enqueue_parts(&self, hash: &str, height: i64, total_block_size: u64) -> Result<()> {
    if self.hash_index.contains_key(hash) {
      return Err(Error::from_reason("Duplicate block hash"));
    }
    if height != self.last_height + 1 {
      return Err(Error::from_reason(format!("Can't enqueue block. Block height: {}, Queue last height: {}", height, self.last_height)));
    }
    if self.last_height >= self.max_block_height {
      return Err(Error::from_reason(format!("Can't enqueue block. Max height reached: {}", self.max_block_height)));
    }
    if self.size.saturating_add(total_block_size) > self.max_queue_size {
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Would exceed memory limit: {}/{} bytes",
        self.size.saturating_add(total_block_size), self.max_queue_size
      )));
    }
    Ok(())
  }

  fn maybe_resize_for_enqueue(&mut self, incoming_size: u64) -> Result<()> {
    self.planner.observe(incoming_size);
    let now = now_ms();
    if let Some(target) = self.planner.should_resize(now, self.max_queue_size, self.blocks.len(), self.current_block_count) {
      self.resize_ring(target);
      self.planner.mark_resized(now);
    }

    if self.current_block_count >= self.blocks.len() {
      let desired = self.planner.desired_slots(self.max_queue_size);
      let doubled = (self.blocks.len() * 2).min(100_000);
      let target = (self.current_block_count + 1).max(desired).max(doubled);
      if target > self.blocks.len() {
        self.resize_ring(target);
        self.planner.mark_resized(now_ms());
      }
      if self.current_block_count >= self.blocks.len() {
        return Err(Error::from_reason(format!("Queue ring buffer capacity exceeded: {}", self.blocks.len())));
      }
    }

    Ok(())
  }

  fn collect_batch_entries(&self, max_size: f64) -> Vec<&BlockEntry> {
    if self.current_block_count == 0 { return vec![]; }

    let mut batch = Vec::new();
    let mut accumulated_size = 0_u64;
    let mut current_index = self.head_index;
    let mut processed_count = 0_usize;
    let max_size_u64 = max_size.max(0.0) as u64;

    while processed_count < self.current_block_count {
      if let Some(Some(entry)) = self.blocks.get(current_index) {
        if accumulated_size.saturating_add(entry.size) > max_size_u64 {
          if batch.is_empty() {
            batch.push(entry);
          }
          break;
        }
        batch.push(entry);
        accumulated_size = accumulated_size.saturating_add(entry.size);
      }
      current_index = (current_index + 1) % self.blocks.len();
      processed_count += 1;
    }

    batch
  }

  fn entry_to_raw_block(entry: &BlockEntry) -> NativeRawBlock {
    NativeRawBlock {
      hash: entry.hash.clone(),
      height: entry.height as f64,
      size: entry.size as f64,
      bytes: entry.bytes.clone(),
    }
  }

  fn resize_ring(&mut self, new_capacity: usize) {
    if new_capacity == self.blocks.len() { return; }
    let old_len = self.blocks.len();
    let mut new_blocks = vec![None; new_capacity];
    self.height_index.clear();
    self.hash_index.clear();

    let mut idx = self.head_index;
    for i in 0..self.current_block_count {
      if let Some(entry) = self.blocks[idx].take() {
        self.height_index.insert(entry.height, i);
        self.hash_index.insert(entry.hash.clone(), i);
        new_blocks[i] = Some(entry);
      }
      idx = (idx + 1) % old_len;
    }

    self.blocks = new_blocks;
    self.head_index = 0;
    self.tail_index = self.current_block_count % self.blocks.len();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn make_queue() -> NativeBlocksQueue {
    NativeBlocksQueue::new(json!({
      "lastHeight": -1,
      "maxQueueSize": 10_000,
      "blockSize": 100,
      "maxBlockHeight": 100,
      "plannerConfig": { "minSlots": 2, "maxSlots": 100 }
    })).expect("queue")
  }

  fn enqueue(queue: &mut NativeBlocksQueue, height: i64, size: usize) {
    let hash = format!("hash{}", height);
    let bytes: Buffer = vec![height as u8; size].into();
    queue.enqueue_bytes(hash, height as f64, size as f64, bytes).expect("enqueue");
  }

  #[test]
  fn batch_selection_keeps_retry_semantics() {
    let mut queue = make_queue();
    enqueue(&mut queue, 0, 100);
    enqueue(&mut queue, 1, 100);

    let first = queue.get_batch_up_to_size(150.0);
    let retry = queue.get_batch_up_to_size(150.0);

    assert_eq!(first.len(), 1);
    assert_eq!(retry.len(), 1);
    assert_eq!(first[0].hash, retry[0].hash);
    assert_eq!(queue.get_length(), 2.0);
  }

  #[test]
  fn dequeue_requires_head_prefix() {
    let mut queue = make_queue();
    enqueue(&mut queue, 0, 100);
    enqueue(&mut queue, 1, 100);

    assert!(queue.dequeue(json!(["hash1"])).is_err());
    assert_eq!(queue.dequeue(json!(["hash0"])).expect("dequeue"), 0.0);
    assert_eq!(queue.get_length(), 1.0);
  }

  #[test]
  fn reorganize_clears_indexes_and_sets_last_height() {
    let mut queue = make_queue();
    enqueue(&mut queue, 0, 100);
    queue.reorganize(10.0);

    assert_eq!(queue.get_length(), 0.0);
    assert_eq!(queue.get_last_height(), 10.0);
    assert!(queue.find_blocks(vec!["hash0".to_string()]).is_empty());
  }
}
