/* 自动生成，勿手改：node worker/scripts/sync-assets.mjs */
export const baselines = {
  "suite": "1.3.0",
  "client": "2.9.6",
  "measured_at": "2026-10-26",
  "machine": {
    "cpu_model": "AMD Ryzen 7 5825U with Radeon Graphics",
    "arch": "x64",
    "cores": 8,
    "threads": 16,
    "mem_gb": 61,
    "boost": "off",
    "freq_mhz": 2000
  },
  "note": "1.3.0：磁盘测试改写不可压缩随机数据（此前全零在 btrfs 压缩下会把顺序读写放大数十倍）；内存延迟环按 CPU L3 动态定（此前固定 32MB，在 L3≥32MB 的 CPU 上测成了缓存延迟）；4K 随机封顶从 50000 收到 30000 IOPS。基准用同一套代码重测。",
  "metrics": {
    "cpu_single": 1817.1,
    "cpu_multi": 15664,
    "crypto_aes": 1199.9,
    "zlib": 27.7,
    "mem_copy": 17.21,
    "mem_latency": 107,
    "disk_seq_read": 399.3,
    "disk_seq_write": 192.3,
    "disk_rand_read": 6302,
    "disk_rand_write": 8828
  },
  "notes": null
};

