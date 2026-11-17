## typescript: 1.1.1 published vs 1.2.0 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.1.1 published: AMD EPYC 9V45 96-Core Processor (5); 1.2.0 checkout: AMD EPYC 9V45 96-Core Processor (5)

| measure | metric | 1.1.1 published | 1.2.0 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0354 (0.0346–0.0361) | 0.0371 (0.036–0.0453) | +5% |
| overhead | plain_p99_ms | 0.148 (0.136–0.161) | 0.161 (0.151–0.177) | +9% (noise) |
| overhead | baton_p50_ms | 0.0898 (0.088–0.0917) | 0.0955 (0.0926–0.0969) | +6% |
| overhead | baton_p99_ms | 1.19 (1.1–1.28) | 1.2 (1.03–1.21) | +0% (noise) |
| overhead | added_p50_ms | 0.0544 (0.0522–0.0568) | 0.0566 (0.0488–0.0598) | +4% (noise) |
| overhead | added_p99_ms | 1.04 (0.957–1.14) | 1.03 (0.883–1.04) | -1% (noise) |
| burst | plain_wall_ms | 307 (302–311) | 310 (301–317) | +1% (noise) |
| burst | plain_call_p50_ms | 0.24 (0.239–0.242) | 0.243 (0.242–0.247) | +1% |
| burst | plain_call_p99_ms | 1.41 (1.28–1.44) | 1.47 (1.25–1.49) | +4% |
| burst | wall_ms | 868 (851–881) | 918 (915–941) | +6% |
| burst | call_p50_ms | 0.712 (0.705–0.756) | 0.685 (0.674–0.697) | -4% |
| burst | call_p99_ms | 2.6 (2.39–2.71) | 2.51 (2.45–2.75) | -4% (noise) |
| burst | added_call_p50_ms | 0.471 (0.465–0.514) | 0.443 (0.431–0.449) | -6% |
| burst | added_call_p99_ms | 1.23 (1.02–1.32) | 1.2 (0.997–1.28) | -2% (noise) |
| burst | close_ms | 1.4 (1.38–1.52) | 1.86 (1.67–2.17) | +32% |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 310 (305–314) | 312 (302–358) | +1% (noise) |
| outage_hang | plain_call_p50_ms | 0.245 (0.242–0.25) | 0.251 (0.244–0.256) | +2% |
| outage_hang | plain_call_p99_ms | 1.24 (1.15–1.29) | 1.28 (1.15–1.47) | +3% (noise) |
| outage_hang | wall_ms | 601 (587–624) | 651 (631–660) | +8% |
| outage_hang | call_p50_ms | 0.481 (0.474–0.491) | 0.527 (0.517–0.53) | +10% |
| outage_hang | call_p99_ms | 1.84 (1.62–2.01) | 1.87 (1.66–2.07) | +2% (noise) |
| outage_hang | added_call_p50_ms | 0.235 (0.224–0.247) | 0.274 (0.26–0.283) | +16% |
| outage_hang | added_call_p99_ms | 0.55 (0.423–0.763) | 0.58 (0.351–0.805) | +5% (noise) |
| outage_hang | close_ms | 3,000 (2,999–3,001) | 3,000 (2,999–3,001) | -0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 325 (311–327) | 324 (313–336) | -0% (noise) |
| outage_down | plain_call_p50_ms | 0.242 (0.241–0.244) | 0.246 (0.242–0.249) | +2% |
| outage_down | plain_call_p99_ms | 1.39 (1.21–1.42) | 1.24 (1.21–1.54) | -11% (noise) |
| outage_down | wall_ms | 603 (601–610) | 646 (625–714) | +7% |
| outage_down | call_p50_ms | 0.484 (0.481–0.486) | 0.527 (0.521–0.541) | +9% |
| outage_down | call_p99_ms | 1.72 (1.61–1.79) | 1.72 (1.57–2.21) | +0% (noise) |
| outage_down | added_call_p50_ms | 0.242 (0.237–0.246) | 0.281 (0.278–0.291) | +16% |
| outage_down | added_call_p99_ms | 0.372 (0.255–0.495) | 0.49 (0.367–0.743) | +32% (noise) |
| outage_down | close_ms | 787 (779–790) | 752 (718–1,378) | -4% |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,524,432 (25,507,632–25,535,144) | 22,567,184 (22,537,840–22,573,960) | -12% |
| memory | heap_at_half_bytes | 25,955,160 (25,913,552–25,959,248) | 23,069,688 (23,042,304–23,081,616) | -11% |
| memory | heap_at_end_bytes | 26,038,864 (26,002,368–26,051,552) | 23,160,160 (23,140,624–23,164,080) | -11% |
| memory | growth_per_call_bytes | 8.96 (8.37–9.23) | 8.87 (7.56–11.3) | -0.0896 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,239,312 (26,201,648–26,249,144) | 23,310,672 (23,263,024–23,401,296) | -11% |
| memory_outage | heap_at_half_bytes | 27,516,808 (27,496,656–27,536,112) | 24,556,888 (24,552,616–24,566,952) | -11% |
| memory_outage | heap_at_end_bytes | 27,466,192 (27,450,752–27,474,440) | 24,517,192 (24,516,440–24,530,976) | -11% |
| memory_outage | growth_per_call_bytes | -4.59 (-6.79–-4.23) | -3.54 (-5.05–-2.59) | +1.05 (noise) |
| large_result | plain_p50_ms | 0.0297 (0.0294–0.0299) | 0.03 (0.0295–0.0306) | +1% |
| large_result | plain_p99_ms | 0.0941 (0.0898–0.0993) | 0.0864 (0.0854–0.0929) | -8% |
| large_result | baton_p50_ms | 0.257 (0.255–0.266) | 0.265 (0.262–0.276) | +3% (noise) |
| large_result | baton_p99_ms | 2.33 (2.28–2.36) | 2.48 (2.35–2.53) | +7% |
| large_result | added_p50_ms | 0.227 (0.225–0.236) | 0.236 (0.232–0.247) | +4% (noise) |
| large_result | added_p99_ms | 2.23 (2.19–2.26) | 2.39 (2.26–2.45) | +8% |
| large_result | heap_growth_bytes | 717,672 (691,832–718,904) | 693,728 (666,720–752,280) | -3% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 218,587,136 (217,513,984–218,804,224) | 203,452,416 (201,629,696–203,816,960) | -7% |
