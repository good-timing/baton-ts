## typescript: 0.6.6 published vs 0.6.7 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.6 published | 0.6.7 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0826 (0.0808–0.0842) | 0.0846 (0.0839–0.0893) | +2% |
| overhead | plain_p99_ms | 0.262 (0.253–0.287) | 0.289 (0.266–0.301) | +10% |
| overhead | baton_p50_ms | 0.205 (0.202–0.209) | 0.216 (0.211–0.222) | +5% |
| overhead | baton_p99_ms | 2.07 (2.04–2.15) | 2 (1.92–2.07) | -3% |
| overhead | added_p50_ms | 0.123 (0.119–0.126) | 0.132 (0.126–0.138) | +8% |
| overhead | added_p99_ms | 1.81 (1.78–1.88) | 1.7 (1.63–1.79) | -6% |
| burst | wall_ms | 1,891 (1,872–1,938) | 1,961 (1,919–2,002) | +4% |
| burst | call_p50_ms | 1.79 (1.76–1.86) | 1.71 (1.61–1.73) | -5% |
| burst | call_p99_ms | 4.51 (4.44–4.71) | 4.71 (4.64–5.16) | +4% (noise) |
| burst | close_ms | 2.55 (2.4–2.68) | 2.57 (2.53–2.59) | +1% (noise) |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | wall_ms | 270 (267–281) | 293 (287–358) | +9% |
| outage_hang | call_p50_ms | 1.18 (1.17–1.22) | 1.27 (1.26–1.5) | +8% |
| outage_hang | call_p99_ms | 3.6 (3.54–3.71) | 3.7 (3.69–4.61) | +3% (noise) |
| outage_hang | close_ms | 3,001 (3,000–3,002) | 3,001 (3,001–3,002) | -0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 262 (255–273) | 304 (290–317) | +16% |
| outage_down | call_p50_ms | 1.12 (1.12–1.16) | 1.24 (1.21–1.25) | +11% |
| outage_down | call_p99_ms | 3.72 (3.42–4.07) | 5.65 (4.16–6.1) | +52% |
| outage_down | close_ms | 1,153 (1,141–1,160) | 1,110 (1,099–1,127) | -4% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 26,641,144 (26,619,896–26,661,920) | 23,415,544 (23,404,488–23,461,320) | -12% |
| memory | heap_at_half_bytes | 27,059,560 (27,036,936–27,067,096) | 22,926,440 (22,358,768–23,843,464) | -15% |
| memory | heap_at_end_bytes | 26,998,408 (26,984,192–27,012,584) | 22,512,928 (22,467,056–22,930,568) | -17% |
| memory | growth_per_call_bytes | -5.29 (-6.56–-4.01) | -41.2 (-91.3–13.5) | -679% |
| memory_outage | heap_after_warmup_bytes | 27,194,688 (27,180,176–27,209,264) | 22,657,112 (22,593,728–23,083,152) | -17% |
| memory_outage | heap_at_half_bytes | 27,489,240 (27,459,328–27,495,232) | 23,839,744 (23,825,664–23,857,856) | -13% |
| memory_outage | heap_at_end_bytes | 26,991,280 (26,967,024–27,006,192) | 23,834,536 (23,803,696–23,851,232) | -12% |
| memory_outage | growth_per_call_bytes | -49.2 (-51.1–-48.3) | -0.662 (-2.59–-0.394) | +99% |
| process | max_rss_bytes | 214,888,448 (213,884,928–215,851,008) | 207,486,976 (206,774,272–208,982,016) | -3% |
