use napi::{Error, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::utils::{now_ms, number_field, string_field};

use super::block_json::cleanup_block_hex;
use super::planner::CapacityPlanner;

#[derive(Clone)]
struct BlockEntry {
  value: Value,
  height: i64,
  hash: String,
  size: u64,
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

    self.blocks
      .get(self.head_index)
      .and_then(|b| b.as_ref())
      .map(|b| b.value.clone())
  }

  #[napi(js_name = "validateEnqueue")]
  pub fn validate_enqueue(&self, meta: Value) -> Result<()> {
    let hash = string_field(&meta, "hash").ok_or_else(|| Error::from_reason("Block hash is required"))?;
    if self.hash_index.contains_key(hash) {
      return Err(Error::from_reason("Duplicate block hash"));
    }

    let height = number_field(&meta, "height").ok_or_else(|| Error::from_reason("Block height is required"))? as i64;
    let total_block_size = number_field(&meta, "size")
      .ok_or_else(|| Error::from_reason("Block size is required"))?
      .max(0.0) as u64;

    self.validate_enqueue_parts(hash, height, total_block_size)
  }

  #[napi(js_name = "enqueueCleaned")]
  pub fn enqueue_cleaned(&mut self, block: Value) -> Result<()> {
    let hash = string_field(&block, "hash")
      .ok_or_else(|| Error::from_reason("Block hash is required"))?
      .to_string();
    let height = number_field(&block, "height").ok_or_else(|| Error::from_reason("Block height is required"))? as i64;
    let total_block_size = number_field(&block, "size")
      .ok_or_else(|| Error::from_reason("Block size is required"))?
      .max(0.0) as u64;

    self.validate_enqueue_parts(&hash, height, total_block_size)?;

    self.planner.observe(total_block_size);
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
        return Err(Error::from_reason(format!(
          "Queue ring buffer capacity exceeded: {}",
          self.blocks.len()
        )));
      }
    }

    self.blocks[self.tail_index] = Some(BlockEntry {
      value: block,
      height,
      hash: hash.clone(),
      size: total_block_size,
    });
    self.height_index.insert(height, self.tail_index);
    self.hash_index.insert(hash, self.tail_index);
    self.tail_index = (self.tail_index + 1) % self.blocks.len();
    self.current_block_count += 1;
    self.size += total_block_size;
    self.last_height = height;

    Ok(())
  }

  #[napi]
  pub fn enqueue(&mut self, mut block: Value) -> Result<()> {
    cleanup_block_hex(&mut block);
    self.enqueue_cleaned(block)
  }

  /// Releases native memory held by queued blocks and indexes.
  ///
  /// This method is intended for explicit shutdown/cleanup from the TS owner.
  /// It clears the queue and shrinks the Rust Vec/HashMap capacities so large
  /// JSON DOM allocations can be returned to the allocator earlier than waiting
  /// for JS GC finalization of the native wrapper. The object remains reusable:
  /// a later enqueue will allocate a fresh ring buffer if needed.
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
      let idx = self
        .hash_index
        .get(&hash)
        .copied()
        .ok_or_else(|| Error::from_reason(format!("Block not found: {}", hash)))?;

      if idx != self.head_index {
        return Err(Error::from_reason(format!("Block not at head of queue: {}", hash)));
      }

      let entry = self.blocks[self.head_index]
        .take()
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

  #[napi(js_name = "fetchBlockFromInStack")]
  pub fn fetch_block_from_in_stack(&self, height: f64) -> Option<Value> {
    let h = height as i64;
    self.height_index
      .get(&h)
      .and_then(|idx| self.blocks.get(*idx))
      .and_then(|b| b.as_ref())
      .map(|b| b.value.clone())
  }

  #[napi(js_name = "fetchBlockFromOutStack")]
  pub fn fetch_block_from_out_stack(&self, height: f64) -> Option<Value> {
    self.fetch_block_from_in_stack(height)
  }

  #[napi(js_name = "findBlocks")]
  pub fn find_blocks(&self, hashes: Vec<String>) -> Vec<Value> {
    let mut out = Vec::new();

    for hash in hashes {
      if let Some(idx) = self.hash_index.get(&hash) {
        if let Some(Some(entry)) = self.blocks.get(*idx) {
          out.push(entry.value.clone());
        }
      }
    }

    out
  }

  #[napi(js_name = "getBatchUpToSize")]
  pub fn get_batch_up_to_size(&self, max_size: f64) -> Vec<Value> {
    if self.current_block_count == 0 {
      return vec![];
    }

    let mut batch = Vec::new();
    let mut accumulated_size = 0_u64;
    let mut current_index = self.head_index;
    let mut processed_count = 0_usize;
    let max_size = max_size.max(0.0) as u64;

    while processed_count < self.current_block_count {
      if let Some(Some(entry)) = self.blocks.get(current_index) {
        if accumulated_size.saturating_add(entry.size) > max_size {
          if batch.is_empty() {
            batch.push(entry.value.clone());
          }
          break;
        }

        batch.push(entry.value.clone());
        accumulated_size = accumulated_size.saturating_add(entry.size);
      }

      current_index = (current_index + 1) % self.blocks.len();
      processed_count += 1;
    }

    batch
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

    self.height_index.clear();
    self.hash_index.clear();
  }

  #[napi]
  pub fn reorganize(&mut self, height: f64) {
    self.clear();
    self.last_height = height as i64;
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
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Block height: {}, Queue last height: {}",
        height, self.last_height
      )));
    }

    if self.last_height >= self.max_block_height {
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Max height reached: {}",
        self.max_block_height
      )));
    }

    if self.size.saturating_add(total_block_size) > self.max_queue_size {
      return Err(Error::from_reason(format!(
        "Can't enqueue block. Would exceed memory limit: {}/{} bytes",
        self.size.saturating_add(total_block_size),
        self.max_queue_size
      )));
    }

    Ok(())
  }

  fn resize_ring(&mut self, new_capacity: usize) {
    if new_capacity == self.blocks.len() {
      return;
    }

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
