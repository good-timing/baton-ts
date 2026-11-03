## typescript: 0.6.4 published vs 0.6.5 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.4 published | 0.6.5 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.117 (0.113–0.12) | 0.117 (0.116–0.124) | +0% (noise) |
| overhead | plain_p99_ms | 0.307 (0.286–0.319) | 0.299 (0.284–0.306) | -2% (noise) |
| overhead | baton_p50_ms | 0.251 (0.25–0.252) | 0.258 (0.258–0.259) | +3% |
| overhead | baton_p99_ms | 1.99 (1.94–2.06) | 1.9 (1.84–1.99) | -4% |
| overhead | added_p50_ms | 0.135 (0.132–0.136) | 0.141 (0.135–0.142) | +5% |
| overhead | added_p99_ms | 1.67 (1.62–1.77) | 1.6 (1.53–1.68) | -4% |
| burst | wall_ms | 2,179 (2,147–2,216) | 2,287 (2,256–2,321) | +5% |
| burst | call_p50_ms | 2.1 (2.07–2.15) | 2.14 (2.11–2.15) | +2% (noise) |
| burst | call_p99_ms | 4.49 (4.43–4.91) | 4.85 (4.76–5.13) | +8% (noise) |
| burst | close_ms | 2.56 (2.38–2.67) | 2.58 (2.39–2.85) | +1% (noise) |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | wall_ms | 350 (344–358) | 367 (364–374) | +5% |
| outage_hang | call_p50_ms | 1.58 (1.58–1.59) | 1.66 (1.65–1.71) | +5% |
| outage_hang | call_p99_ms | 3.98 (3.87–4.25) | 3.93 (3.8–4.5) | -1% (noise) |
| outage_hang | close_ms | 3,001 (3,000–3,002) | 3,000 (2,999–3,001) | -0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 353 (337–358) | 364 (354–380) | +3% |
| outage_down | call_p50_ms | 1.51 (1.51–1.53) | 1.66 (1.61–1.73) | +10% |
| outage_down | call_p99_ms | 4.9 (3.83–5.42) | 4.01 (3.98–4.41) | -18% (noise) |
| outage_down | close_ms | 1,062 (1,059–1,077) | 1,050 (1,036–1,063) | -1% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 26,549,480 (25,610,184–26,567,608) | 23,399,992 (23,391,736–23,436,976) | -12% |
| memory | heap_at_half_bytes | 25,497,896 (25,465,640–25,968,200) | 22,848,856 (22,812,832–23,813,008) | -10% |
| memory | heap_at_end_bytes | 25,571,072 (25,555,368–25,590,384) | 22,492,776 (22,460,128–22,915,344) | -12% |
| memory | growth_per_call_bytes | 7.34 (-40.4–10.9) | -35.6 (-89.8–-32.7) | -42.9 (noise) |
| memory_outage | heap_after_warmup_bytes | 25,734,840 (25,718,728–25,746,432) | 22,629,208 (22,598,192–23,059,096) | -12% |
| memory_outage | heap_at_half_bytes | 26,941,912 (26,922,040–26,954,984) | 23,801,832 (23,786,640–23,811,976) | -12% |
| memory_outage | heap_at_end_bytes | 26,910,024 (26,902,656–26,928,264) | 23,796,720 (23,780,448–23,807,856) | -12% |
| memory_outage | growth_per_call_bytes | -2.81 (-3.83–-1.94) | -0.299 (-2.03–0.0784) | +89% |
| process | max_rss_bytes | 218,275,840 (215,834,624–220,139,520) | 207,056,896 (205,369,344–207,265,792) | -5% |
