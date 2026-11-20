## typescript: 1.3.0 published vs 1.3.1 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.3.0 published: Intel(R) Xeon(R) 6975P-C (5); 1.3.1 checkout: Intel(R) Xeon(R) 6975P-C (5)

| measure | metric | 1.3.0 published | 1.3.1 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0482 (0.0452–0.0549) | 0.0514 (0.048–0.0546) | +7% (noise) |
| overhead | plain_p99_ms | 0.172 (0.163–0.18) | 0.177 (0.154–0.182) | +3% (noise) |
| overhead | baton_p50_ms | 0.102 (0.102–0.104) | 0.103 (0.101–0.105) | +0% (noise) |
| overhead | baton_p99_ms | 1.37 (1.3–1.51) | 1.34 (1.23–1.45) | -2% (noise) |
| overhead | added_p50_ms | 0.054 (0.0489–0.0571) | 0.0511 (0.0478–0.057) | -5% (noise) |
| overhead | added_p99_ms | 1.2 (1.14–1.33) | 1.17 (1.08–1.27) | -3% (noise) |
| burst | plain_wall_ms | 382 (376–405) | 383 (376–386) | +0% (noise) |
| burst | plain_call_p50_ms | 0.308 (0.305–0.315) | 0.312 (0.31–0.314) | +1% (noise) |
| burst | plain_call_p99_ms | 1.74 (1.6–1.81) | 1.62 (1.51–1.76) | -7% (noise) |
| burst | wall_ms | 1,103 (1,085–1,127) | 1,142 (1,109–1,161) | +4% |
| burst | call_p50_ms | 0.857 (0.815–0.992) | 0.853 (0.823–0.88) | -0% (noise) |
| burst | call_p99_ms | 3.09 (2.93–3.28) | 3.08 (2.9–3.19) | -1% (noise) |
| burst | added_call_p50_ms | 0.549 (0.503–0.678) | 0.541 (0.513–0.566) | -1% (noise) |
| burst | added_call_p99_ms | 1.38 (1.24–1.54) | 1.39 (1.32–1.57) | +0% (noise) |
| burst | close_ms | 1.69 (1.59–1.74) | 1.98 (1.86–2.12) | +17% |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 386 (385–417) | 390 (382–391) | +1% (noise) |
| outage_hang | plain_call_p50_ms | 0.315 (0.312–0.322) | 0.317 (0.315–0.322) | +1% (noise) |
| outage_hang | plain_call_p99_ms | 1.6 (1.47–1.7) | 1.51 (1.39–1.66) | -6% (noise) |
| outage_hang | wall_ms | 798 (767–825) | 801 (793–816) | +0% (noise) |
| outage_hang | call_p50_ms | 0.644 (0.631–0.653) | 0.662 (0.654–0.676) | +3% |
| outage_hang | call_p99_ms | 2.27 (2–2.37) | 2.19 (2.17–2.23) | -3% (noise) |
| outage_hang | added_call_p50_ms | 0.327 (0.315–0.337) | 0.346 (0.337–0.359) | +6% |
| outage_hang | added_call_p99_ms | 0.652 (0.529–0.752) | 0.684 (0.53–0.794) | +5% (noise) |
| outage_hang | close_ms | 3,002 (3,000–3,002) | 3,001 (3,001–3,002) | -0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 402 (397–439) | 395 (389–405) | -2% |
| outage_down | plain_call_p50_ms | 0.313 (0.309–0.325) | 0.314 (0.31–0.317) | +0% (noise) |
| outage_down | plain_call_p99_ms | 1.64 (1.52–2.09) | 1.61 (1.48–1.81) | -2% (noise) |
| outage_down | wall_ms | 799 (779–839) | 815 (805–858) | +2% (noise) |
| outage_down | call_p50_ms | 0.649 (0.641–0.653) | 0.676 (0.662–0.683) | +4% |
| outage_down | call_p99_ms | 2.32 (2.06–2.61) | 2.26 (2.01–2.34) | -2% (noise) |
| outage_down | added_call_p50_ms | 0.333 (0.327–0.34) | 0.362 (0.348–0.373) | +9% |
| outage_down | added_call_p99_ms | 0.548 (0.461–0.708) | 0.581 (0.483–0.711) | +6% (noise) |
| outage_down | close_ms | 1,291 (1,250–1,311) | 1,274 (1,234–1,284) | -1% (noise) |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 26,177,968 (26,155,944–26,203,960) | 23,171,472 (23,150,432–23,196,920) | -11% |
| memory | heap_at_half_bytes | 26,121,408 (26,103,752–26,130,464) | 23,191,696 (23,161,112–23,213,320) | -11% |
| memory | heap_at_end_bytes | 26,229,712 (26,223,304–26,259,136) | 23,288,992 (23,246,872–23,307,584) | -11% |
| memory | growth_per_call_bytes | 12 (10.7–12.9) | 8.58 (7.69–10.5) | -3.38 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,439,912 (26,414,248–26,543,832) | 23,443,168 (23,419,792–23,557,744) | -11% |
| memory_outage | heap_at_half_bytes | 27,703,728 (27,677,192–27,705,152) | 24,689,760 (24,670,712–24,705,920) | -11% |
| memory_outage | heap_at_end_bytes | 27,665,040 (27,635,424–27,685,208) | 24,655,000 (24,643,968–24,663,000) | -11% |
| memory_outage | growth_per_call_bytes | -4.01 (-5.94–-1.2) | -3.19 (-5.51–-2.67) | +0.82 (noise) |
| large_result | plain_p50_ms | 0.0378 (0.0371–0.049) | 0.0377 (0.0373–0.0381) | -0% (noise) |
| large_result | plain_p99_ms | 0.117 (0.112–0.128) | 0.116 (0.108–0.142) | -1% (noise) |
| large_result | baton_p50_ms | 0.46 (0.454–0.467) | 0.47 (0.467–0.47) | +2% |
| large_result | baton_p99_ms | 3.35 (3.27–3.44) | 3.33 (3.28–3.37) | -1% (noise) |
| large_result | added_p50_ms | 0.42 (0.417–0.423) | 0.432 (0.429–0.432) | +3% |
| large_result | added_p99_ms | 3.23 (3.16–3.33) | 3.22 (3.17–3.24) | -0% (noise) |
| large_result | heap_growth_bytes | 700,248 (694,608–712,624) | 731,808 (707,504–738,976) | +5% |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 219,574,272 (218,324,992–220,250,112) | 208,863,232 (203,444,224–216,698,880) | -5% |
