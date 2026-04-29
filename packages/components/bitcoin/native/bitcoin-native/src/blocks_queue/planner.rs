use serde_json::Value;

#[derive(Clone)]
pub struct CapacityPlanner {
  ema_avg_size: f64,
  last_resize_at: u64,
  max_slots: usize,
  min_slots: usize,
  min_avg_bytes: f64,
  max_avg_bytes: f64,
  alpha: f64,
  grow_threshold: f64,
  shrink_threshold: f64,
  resize_cooldown_ms: u64,
}

impl CapacityPlanner {
  pub fn new(initial_avg_bytes: f64, cfg: Option<&Value>) -> Self {
    let get_num = |key: &str, default: f64| -> f64 {
      cfg.and_then(|v| v.get(key)).and_then(Value::as_f64).unwrap_or(default)
    };
    let get_usize = |key: &str, default: usize| -> usize {
      cfg.and_then(|v| v.get(key)).and_then(Value::as_u64).map(|v| v as usize).unwrap_or(default)
    };
    let get_u64 = |key: &str, default: u64| -> u64 {
      cfg.and_then(|v| v.get(key)).and_then(Value::as_u64).unwrap_or(default)
    };

    let min_avg_bytes = get_num("minAvgBytes", 256.0);
    let max_avg_bytes = get_num("maxAvgBytes", 64.0 * 1024.0);
    let clamped = initial_avg_bytes.max(min_avg_bytes).min(max_avg_bytes);

    Self {
      ema_avg_size: clamped,
      last_resize_at: 0,
      max_slots: get_usize("maxSlots", 100_000),
      min_slots: get_usize("minSlots", 1),
      min_avg_bytes,
      max_avg_bytes,
      alpha: get_num("alpha", 0.05),
      grow_threshold: get_num("growThreshold", 0.3),
      shrink_threshold: get_num("shrinkThreshold", 0.4),
      resize_cooldown_ms: get_u64("resizeCooldownMs", 10_000),
    }
  }

  pub fn observe(&mut self, sample_bytes: u64) {
    let sample = (sample_bytes as f64).max(1.0).min(self.max_avg_bytes * 4.0);
    self.ema_avg_size = self.alpha * sample + (1.0 - self.alpha) * self.ema_avg_size;
    self.ema_avg_size = self.ema_avg_size.max(self.min_avg_bytes).min(self.max_avg_bytes);
  }

  pub fn desired_slots(&self, max_queue_bytes: u64) -> usize {
    let base = self.ema_avg_size.max(1.0);
    let raw = (max_queue_bytes as f64 / base).floor() as usize;
    raw.max(self.min_slots).min(self.max_slots)
  }

  pub fn should_resize(
    &self,
    now: u64,
    max_queue_bytes: u64,
    current_capacity: usize,
    current_count: usize,
  ) -> Option<usize> {
    if now.saturating_sub(self.last_resize_at) < self.resize_cooldown_ms {
      return None;
    }

    let desired = self.desired_slots(max_queue_bytes);
    let need_grow = desired > ((current_capacity as f64) * (1.0 + self.grow_threshold)).floor() as usize;
    let need_shrink = desired < ((current_capacity as f64) * (1.0 - self.shrink_threshold)).ceil() as usize
      && desired >= current_count;

    if need_grow || need_shrink {
      Some(desired.max(current_count))
    } else {
      None
    }
  }

  pub fn mark_resized(&mut self, now: u64) {
    self.last_resize_at = now;
  }
}
