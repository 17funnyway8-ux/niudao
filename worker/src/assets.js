/* 自动生成，勿手改：node worker/scripts/sync-assets.mjs */
export const baselines = {
  "suite": "1.1.0",
  "client": "2.9.3",
  "measured_at": "2026-10-25",
  "machine": {
    "cpu_model": "AMD Ryzen 7 5825U with Radeon Graphics",
    "arch": "x64",
    "cores": 8,
    "threads": 16,
    "mem_gb": 61,
    "boost": "off",
    "freq_mhz": 2000
  },
  "note": "内存两项按修正后的方法重测（预热一次完整 memcpy 消除首测缺页污染、多次取中位数；32MB/4M 步的延迟口径保持不变）。",
  "metrics": {
    "cpu_single": 1814.7,
    "cpu_multi": 14556.8,
    "crypto_aes": 1239.4,
    "zlib": 27,
    "mem_copy": 16.63,
    "mem_latency": 122,
    "disk_seq_read": 419.5,
    "disk_seq_write": 202,
    "disk_rand_read": 6299,
    "disk_rand_write": 8573
  },
  "notes": null
};

