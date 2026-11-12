## typescript: 1.0.1 published vs 1.1.0 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.0.1 published: AMD EPYC 9V74 80-Core Processor (5); 1.1.0 checkout: AMD EPYC 9V74 80-Core Processor (5)

| measure | metric | 1.0.1 published | 1.1.0 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0675 (0.0656–0.0689) | 0.067 (0.0664–0.0691) | -1% (noise) |
| overhead | plain_p99_ms | 0.208 (0.2–0.221) | 0.22 (0.2–0.239) | +6% (noise) |
| overhead | baton_p50_ms | 0.168 (0.165–0.172) | 0.173 (0.171–0.177) | +2% |
| overhead | baton_p99_ms | 1.6 (1.54–1.62) | 1.63 (1.54–1.65) | +2% |
| overhead | added_p50_ms | 0.103 (0.0978–0.104) | 0.106 (0.103–0.11) | +3% |
| overhead | added_p99_ms | 1.4 (1.33–1.41) | 1.39 (1.31–1.45) | -0% (noise) |
| burst | plain_wall_ms | 452 (446–460) | 458 (453–465) | +1% (noise) |
| burst | plain_call_p50_ms | 0.357 (0.353–0.364) | 0.362 (0.359–0.365) | +1% (noise) |
| burst | plain_call_p99_ms | 2.04 (1.99–2.09) | 2.08 (2.03–2.15) | +2% (noise) |
| burst | wall_ms | 1,388 (1,373–1,435) | 1,472 (1,438–1,491) | +6% |
| burst | call_p50_ms | 1.29 (1.25–1.33) | 1.33 (1.31–1.4) | +3% (noise) |
| burst | call_p99_ms | 3.61 (3.35–3.94) | 3.62 (3.21–3.81) | +0% (noise) |
| burst | added_call_p50_ms | 0.933 (0.885–0.978) | 0.97 (0.944–1.04) | +4% (noise) |
| burst | added_call_p99_ms | 1.55 (1.26–1.95) | 1.49 (1.12–1.79) | -4% (noise) |
| burst | close_ms | 1.97 (1.88–3.26) | 1.89 (1.87–2.05) | -4% (noise) |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 454 (450–460) | 467 (457–470) | +3% |
| outage_hang | plain_call_p50_ms | 0.363 (0.362–0.365) | 0.371 (0.367–0.374) | +2% |
| outage_hang | plain_call_p99_ms | 1.87 (1.81–1.88) | 1.9 (1.83–1.96) | +1% |
| outage_hang | wall_ms | 1,032 (1,009–1,038) | 1,126 (1,106–1,147) | +9% |
| outage_hang | call_p50_ms | 0.85 (0.847–0.864) | 0.94 (0.929–0.948) | +11% |
| outage_hang | call_p99_ms | 2.74 (2.57–2.8) | 2.8 (2.69–2.92) | +2% (noise) |
| outage_hang | added_call_p50_ms | 0.486 (0.481–0.502) | 0.568 (0.559–0.574) | +17% |
| outage_hang | added_call_p99_ms | 0.917 (0.707–0.933) | 0.933 (0.74–1.02) | +2% |
| outage_hang | close_ms | 3,001 (3,000–3,002) | 3,000 (3,000–3,001) | -0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 467 (465–510) | 469 (460–483) | +0% (noise) |
| outage_down | plain_call_p50_ms | 0.362 (0.358–0.367) | 0.365 (0.36–0.368) | +1% (noise) |
| outage_down | plain_call_p99_ms | 1.83 (1.8–2.1) | 1.92 (1.8–2.03) | +5% (noise) |
| outage_down | wall_ms | 1,048 (1,039–1,056) | 1,122 (1,118–1,131) | +7% |
| outage_down | call_p50_ms | 0.864 (0.858–0.867) | 0.949 (0.94–0.961) | +10% |
| outage_down | call_p99_ms | 2.65 (2.61–2.89) | 2.68 (2.62–2.88) | +1% (noise) |
| outage_down | added_call_p50_ms | 0.501 (0.498–0.506) | 0.587 (0.574–0.593) | +17% |
| outage_down | added_call_p99_ms | 0.813 (0.55–1.06) | 0.82 (0.768–0.872) | +1% (noise) |
| outage_down | close_ms | 1,037 (1,028–1,040) | 957 (949–960) | -8% |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,431,928 (25,414,344–25,448,904) | 22,457,368 (22,426,744–22,476,544) | -12% |
| memory | heap_at_half_bytes | 25,835,152 (25,827,808–25,866,984) | 22,902,664 (22,865,176–22,922,840) | -11% |
| memory | heap_at_end_bytes | 25,925,272 (25,901,736–25,950,200) | 23,016,200 (22,983,480–23,018,200) | -11% |
| memory | growth_per_call_bytes | 8.78 (7.17–10.1) | 11.4 (8.46–11.8) | +2.63 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,146,208 (26,120,032–26,235,320) | 23,146,192 (23,109,504–23,289,520) | -11% |
| memory_outage | heap_at_half_bytes | 27,341,128 (27,322,440–27,373,760) | 24,400,456 (24,371,816–24,413,896) | -11% |
| memory_outage | heap_at_end_bytes | 27,305,528 (27,271,312–27,313,216) | 24,363,280 (24,326,328–24,371,200) | -11% |
| memory_outage | growth_per_call_bytes | -5.34 (-6.05–-3.05) | -4.02 (-5.33–-3.71) | +1.32 (noise) |
| large_result | plain_p50_ms | 0.0473 (0.0453–0.0478) | 0.0467 (0.0461–0.0481) | -1% (noise) |
| large_result | plain_p99_ms | 0.143 (0.137–0.155) | 0.139 (0.134–0.145) | -2% (noise) |
| large_result | baton_p50_ms | 0.547 (0.544–0.547) | 0.557 (0.555–0.56) | +2% |
| large_result | baton_p99_ms | 3.25 (3.09–3.34) | 3.37 (3.33–3.49) | +4% |
| large_result | added_p50_ms | 0.499 (0.497–0.501) | 0.51 (0.507–0.513) | +2% |
| large_result | added_p99_ms | 3.1 (2.94–3.2) | 3.23 (3.19–3.36) | +4% |
| large_result | heap_growth_bytes | 758,272 (750,728–763,864) | 749,224 (711,712–788,408) | -1% |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 216,576,000 (216,465,408–220,082,176) | 201,809,920 (201,154,560–205,115,392) | -7% |
