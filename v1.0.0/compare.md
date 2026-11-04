## typescript: 0.6.8 published vs 1.0.0 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.8 published | 1.0.0 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0849 (0.0817–0.0964) | 0.083 (0.0822–0.0878) | -2% (noise) |
| overhead | plain_p99_ms | 0.275 (0.258–0.292) | 0.263 (0.246–0.314) | -4% (noise) |
| overhead | baton_p50_ms | 0.204 (0.202–0.214) | 0.22 (0.215–0.302) | +8% |
| overhead | baton_p99_ms | 2.02 (1.99–2.19) | 2.08 (1.98–2.21) | +3% (noise) |
| overhead | added_p50_ms | 0.12 (0.107–0.129) | 0.137 (0.127–0.219) | +14% |
| overhead | added_p99_ms | 1.74 (1.74–1.9) | 1.77 (1.72–1.91) | +1% (noise) |
| burst | wall_ms | 1,873 (1,843–2,101) | 2,010 (1,998–2,193) | +7% (noise) |
| burst | call_p50_ms | 1.78 (1.72–1.97) | 1.82 (1.75–1.9) | +2% (noise) |
| burst | call_p99_ms | 4.46 (4.37–5.38) | 4.99 (4.63–5.73) | +12% (noise) |
| burst | close_ms | 2.76 (2.62–2.86) | 2.86 (2.55–3.48) | +3% (noise) |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | wall_ms | 275 (265–282) | 300 (298–309) | +9% |
| outage_hang | call_p50_ms | 1.2 (1.16–1.23) | 1.3 (1.28–1.33) | +9% |
| outage_hang | call_p99_ms | 3.51 (3.44–3.85) | 3.8 (3.58–4.34) | +8% (noise) |
| outage_hang | close_ms | 3,001 (3,000–3,002) | 3,001 (3,001–3,002) | +0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 263 (253–274) | 304 (294–321) | +15% |
| outage_down | call_p50_ms | 1.12 (1.09–1.16) | 1.23 (1.22–1.25) | +10% |
| outage_down | call_p99_ms | 3.9 (3.34–4.88) | 4.41 (3.86–6.63) | +13% (noise) |
| outage_down | close_ms | 1,150 (1,140–1,159) | 1,112 (1,092–1,122) | -3% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 26,634,120 (26,627,784–26,644,816) | 23,698,952 (23,609,664–23,733,816) | -11% |
| memory | heap_at_half_bytes | 27,031,248 (27,010,360–27,064,672) | 22,684,976 (22,648,232–24,133,280) | -16% |
| memory | heap_at_end_bytes | 26,992,816 (26,989,408–27,000,528) | 22,800,952 (22,757,072–23,218,528) | -16% |
| memory | growth_per_call_bytes | -4.05 (-7.19–-2.1) | 10.9 (-91.5–14.4) | +369% |
| memory_outage | heap_after_warmup_bytes | 27,195,984 (27,187,768–27,198,600) | 22,945,920 (22,917,592–23,390,928) | -16% |
| memory_outage | heap_at_half_bytes | 27,479,256 (27,435,904–27,497,512) | 24,206,032 (24,171,912–24,222,160) | -12% |
| memory_outage | heap_at_end_bytes | 26,986,824 (26,943,608–27,018,616) | 24,197,472 (24,170,632–24,218,504) | -10% |
| memory_outage | growth_per_call_bytes | -49.2 (-49.7–-47.9) | -0.626 (-1.13–-0.128) | +99% |
| large_result | plain_p50_ms | 0.0641 (0.0633–0.0651) | 0.065 (0.0635–0.0655) | +1% (noise) |
| large_result | plain_p99_ms | 0.193 (0.18–0.211) | 0.192 (0.186–0.216) | -0% (noise) |
| large_result | baton_p50_ms | 0.662 (0.603–0.682) | 0.66 (0.625–0.691) | -0% (noise) |
| large_result | baton_p99_ms | 4.21 (3.98–4.4) | 4.18 (4.17–4.79) | -1% (noise) |
| large_result | added_p50_ms | 0.598 (0.538–0.618) | 0.595 (0.559–0.628) | -0% (noise) |
| large_result | added_p99_ms | 4.02 (3.79–4.19) | 3.99 (3.98–4.57) | -1% (noise) |
| large_result | heap_growth_bytes | 744,160 (700,912–781,888) | 737,040 (720,168–765,616) | -1% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 214,298,624 (209,977,344–217,858,048) | 205,955,072 (205,115,392–209,903,616) | -4% |
