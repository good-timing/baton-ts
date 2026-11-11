## typescript: 1.0.0 published vs 1.0.1 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.0.0 published: AMD EPYC 9V74 80-Core Processor (5); 1.0.1 checkout: AMD EPYC 9V74 80-Core Processor (5)

| measure | metric | 1.0.0 published | 1.0.1 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0666 (0.0663–0.0678) | 0.0672 (0.066–0.069) | +1% (noise) |
| overhead | plain_p99_ms | 0.221 (0.207–0.23) | 0.21 (0.207–0.235) | -5% (noise) |
| overhead | baton_p50_ms | 0.168 (0.166–0.171) | 0.174 (0.169–0.183) | +4% |
| overhead | baton_p99_ms | 1.57 (1.53–1.69) | 1.66 (1.61–1.78) | +5% (noise) |
| overhead | added_p50_ms | 0.101 (0.0997–0.103) | 0.108 (0.102–0.116) | +7% |
| overhead | added_p99_ms | 1.34 (1.3–1.49) | 1.42 (1.4–1.55) | +6% (noise) |
| burst | plain_wall_ms | 456 (451–466) | 461 (457–466) | +1% (noise) |
| burst | plain_call_p50_ms | 0.357 (0.352–0.358) | 0.363 (0.361–0.365) | +2% |
| burst | plain_call_p99_ms | 2.1 (1.91–2.21) | 2.18 (2.14–2.19) | +4% (noise) |
| burst | wall_ms | 1,399 (1,392–1,422) | 1,482 (1,476–1,543) | +6% |
| burst | call_p50_ms | 1.28 (1.24–1.33) | 1.3 (1.16–1.34) | +2% (noise) |
| burst | call_p99_ms | 3.85 (3.53–3.9) | 3.6 (3.33–3.85) | -6% (noise) |
| burst | added_call_p50_ms | 0.921 (0.878–0.976) | 0.938 (0.798–0.981) | +2% (noise) |
| burst | added_call_p99_ms | 1.67 (1.47–1.94) | 1.43 (1.14–1.71) | -14% |
| burst | close_ms | 1.95 (1.73–2.13) | 1.99 (1.93–2.25) | +2% (noise) |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 461 (456–488) | 462 (461–466) | +0% (noise) |
| outage_hang | plain_call_p50_ms | 0.366 (0.36–0.37) | 0.371 (0.37–0.374) | +1% |
| outage_hang | plain_call_p99_ms | 1.9 (1.62–2.16) | 1.92 (1.84–2.02) | +1% (noise) |
| outage_hang | wall_ms | 1,054 (1,037–1,121) | 1,124 (1,104–1,174) | +7% |
| outage_hang | call_p50_ms | 0.873 (0.857–0.887) | 0.938 (0.929–0.955) | +8% |
| outage_hang | call_p99_ms | 2.85 (2.81–3.21) | 2.93 (2.74–3.23) | +3% (noise) |
| outage_hang | added_call_p50_ms | 0.508 (0.488–0.518) | 0.567 (0.559–0.584) | +12% |
| outage_hang | added_call_p99_ms | 0.951 (0.648–1.47) | 0.931 (0.854–1.4) | -2% (noise) |
| outage_hang | close_ms | 3,001 (3,001–3,002) | 3,002 (3,001–3,003) | +0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 462 (460–479) | 482 (455–486) | +4% |
| outage_down | plain_call_p50_ms | 0.359 (0.355–0.361) | 0.367 (0.362–0.368) | +2% |
| outage_down | plain_call_p99_ms | 1.87 (1.85–1.97) | 1.96 (1.75–2.05) | +5% (noise) |
| outage_down | wall_ms | 1,056 (1,039–1,092) | 1,137 (1,105–1,176) | +8% |
| outage_down | call_p50_ms | 0.869 (0.859–0.885) | 0.942 (0.929–0.955) | +8% |
| outage_down | call_p99_ms | 2.72 (2.64–3.01) | 2.84 (2.71–3.24) | +4% (noise) |
| outage_down | added_call_p50_ms | 0.51 (0.497–0.528) | 0.574 (0.567–0.588) | +13% |
| outage_down | added_call_p99_ms | 0.839 (0.678–1.16) | 0.888 (0.776–1.19) | +6% (noise) |
| outage_down | close_ms | 1,027 (996–1,044) | 946 (901–977) | -8% |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,447,936 (25,429,672–25,460,272) | 22,414,272 (22,381,000–22,416,360) | -12% |
| memory | heap_at_half_bytes | 25,861,440 (25,861,208–25,873,560) | 22,869,160 (22,830,696–22,875,728) | -12% |
| memory | heap_at_end_bytes | 25,954,168 (25,944,976–25,968,000) | 22,953,736 (22,935,608–22,980,392) | -12% |
| memory | growth_per_call_bytes | 8.96 (8.37–9.85) | 10.5 (7.17–12.3) | +1.49 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,151,576 (26,145,928–26,164,896) | 23,098,136 (23,086,928–23,106,776) | -12% |
| memory_outage | heap_at_half_bytes | 27,373,024 (27,369,152–27,394,808) | 24,351,920 (24,337,240–24,363,152) | -11% |
| memory_outage | heap_at_end_bytes | 27,341,664 (27,336,600–27,363,560) | 24,316,280 (24,297,688–24,338,888) | -11% |
| memory_outage | growth_per_call_bytes | -3.14 (-3.59–-2.94) | -4.09 (-4.41–-1.3) | -0.955 (noise) |
| large_result | plain_p50_ms | 0.0472 (0.0468–0.0473) | 0.0475 (0.0457–0.0479) | +1% |
| large_result | plain_p99_ms | 0.149 (0.133–0.158) | 0.141 (0.139–0.165) | -6% (noise) |
| large_result | baton_p50_ms | 0.542 (0.54–0.544) | 0.561 (0.56–0.565) | +4% |
| large_result | baton_p99_ms | 3.09 (3.03–3.17) | 3.52 (3.4–3.56) | +14% |
| large_result | added_p50_ms | 0.495 (0.493–0.497) | 0.514 (0.513–0.517) | +4% |
| large_result | added_p99_ms | 2.94 (2.88–3.01) | 3.35 (3.26–3.41) | +14% |
| large_result | heap_growth_bytes | 748,528 (719,968–750,736) | 742,984 (698,776–795,616) | -1% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 218,603,520 (218,378,240–220,299,264) | 200,384,512 (198,684,672–202,502,144) | -8% |
