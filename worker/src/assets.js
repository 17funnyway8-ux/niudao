/* 自动生成，勿手改：node worker/scripts/sync-assets.mjs */
export const baselines = {
  "suite": "1.4.0",
  "client": "2.9.7",
  "measured_at": "2026-10-27",
  "machine": {
    "cpu_model": "AMD Ryzen 7 5825U with Radeon Graphics",
    "arch": "x64",
    "cores": 8,
    "threads": 16,
    "mem_gb": 61,
    "boost": "off",
    "freq_mhz": 2000
  },
  "note": "1.3.0：磁盘测试改写不可压缩随机数据（此前全零在 btrfs 压缩下会把顺序读写放大数十倍）；内存延迟环按 CPU L3 动态定（此前固定 32MB，在 L3≥32MB 的 CPU 上测成了缓存延迟）；4K 随机封顶从 50000 收到 30000 IOPS。基准用同一套代码重测。 1.4.0：4K 随机 IOPS 改为用延迟做真实性校验 —— 延迟低于持久化存储的物理下限（10μs）的项直接剔除评分，不再靠 IOPS 数值封顶（那会误伤 Optane 这类 QD1 能到 40-60k 的真盘）。基准机 4K 延迟实测 164.2/113μs。",
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
    "disk_rand_write": 8828,
    "disk_rand_read_lat_us": 164.2,
    "disk_rand_write_lat_us": 113
  },
  "notes": null
};

