## typescript: 1.2.0 published vs 1.2.1 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.2.0 published: AMD EPYC 9V45 96-Core Processor (5); 1.2.1 checkout: AMD EPYC 9V45 96-Core Processor (5)

| measure | metric | 1.2.0 published | 1.2.1 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0358 (0.0344–0.0421) | 0.0361 (0.0354–0.0457) | +1% (noise) |
| overhead | plain_p99_ms | 0.152 (0.138–0.154) | 0.163 (0.15–0.167) | +7% |
| overhead | baton_p50_ms | 0.0904 (0.0881–0.0931) | 0.0938 (0.0909–0.0955) | +4% |
| overhead | baton_p99_ms | 1.11 (1.05–1.15) | 1.06 (1.03–1.09) | -4% (noise) |
| overhead | added_p50_ms | 0.0546 (0.051–0.0554) | 0.0568 (0.0453–0.0596) | +4% |
| overhead | added_p99_ms | 0.955 (0.901–0.996) | 0.902 (0.877–0.923) | -5% (noise) |
| burst | plain_wall_ms | 296 (293–304) | 301 (295–305) | +2% (noise) |
| burst | plain_call_p50_ms | 0.236 (0.234–0.237) | 0.241 (0.237–0.245) | +2% |
| burst | plain_call_p99_ms | 1.23 (1.21–1.27) | 1.25 (1.2–1.3) | +1% (noise) |
| burst | wall_ms | 846 (842–889) | 904 (881–910) | +7% |
| burst | call_p50_ms | 0.675 (0.64–0.694) | 0.708 (0.676–0.735) | +5% |
| burst | call_p99_ms | 2.55 (2.38–2.59) | 2.31 (2.2–2.38) | -10% |
| burst | added_call_p50_ms | 0.439 (0.403–0.457) | 0.467 (0.439–0.49) | +6% |
| burst | added_call_p99_ms | 1.3 (1.15–1.37) | 1.01 (0.989–1.13) | -22% |
| burst | close_ms | 1.36 (1.29–1.4) | 1.73 (1.55–2.3) | +27% |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 301 (294–313) | 302 (300–304) | +0% (noise) |
| outage_hang | plain_call_p50_ms | 0.242 (0.237–0.252) | 0.245 (0.244–0.247) | +1% (noise) |
| outage_hang | plain_call_p99_ms | 1.1 (1.06–1.14) | 1.08 (1.07–1.1) | -2% (noise) |
| outage_hang | wall_ms | 590 (568–595) | 614 (610–618) | +4% |
| outage_hang | call_p50_ms | 0.479 (0.467–0.482) | 0.51 (0.507–0.513) | +6% |
| outage_hang | call_p99_ms | 1.53 (1.49–1.62) | 1.57 (1.53–1.61) | +2% (noise) |
| outage_hang | added_call_p50_ms | 0.237 (0.225–0.244) | 0.265 (0.262–0.269) | +12% |
| outage_hang | added_call_p99_ms | 0.447 (0.385–0.494) | 0.5 (0.446–0.526) | +12% |
| outage_hang | close_ms | 3,000 (2,999–3,001) | 3,000 (2,999–3,001) | -0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 311 (307–315) | 312 (311–325) | +0% (noise) |
| outage_down | plain_call_p50_ms | 0.238 (0.235–0.239) | 0.241 (0.239–0.249) | +1% |
| outage_down | plain_call_p99_ms | 1.17 (1.13–1.21) | 1.15 (1.14–1.2) | -1% (noise) |
| outage_down | wall_ms | 593 (590–596) | 627 (615–658) | +6% |
| outage_down | call_p50_ms | 0.48 (0.478–0.485) | 0.515 (0.509–0.54) | +7% |
| outage_down | call_p99_ms | 1.62 (1.55–1.73) | 1.6 (1.49–1.7) | -1% (noise) |
| outage_down | added_call_p50_ms | 0.243 (0.241–0.247) | 0.275 (0.268–0.291) | +13% |
| outage_down | added_call_p99_ms | 0.468 (0.349–0.539) | 0.448 (0.345–0.547) | -4% (noise) |
| outage_down | close_ms | 796 (791–801) | 762 (731–775) | -4% |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,580,680 (25,563,656–26,038,120) | 22,591,160 (22,565,984–23,074,816) | -12% |
| memory | heap_at_half_bytes | 26,021,192 (26,017,016–26,037,200) | 23,115,664 (23,063,344–23,121,440) | -11% |
| memory | heap_at_end_bytes | 26,110,560 (26,101,936–26,121,568) | 23,173,368 (23,143,584–23,193,256) | -11% |
| memory | growth_per_call_bytes | 8.85 (7.34–9.56) | 7.34 (5.64–8.02) | -1.5 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,309,160 (26,292,624–26,317,568) | 23,324,648 (23,288,928–23,343,248) | -11% |
| memory_outage | heap_at_half_bytes | 27,576,680 (27,568,080–27,580,552) | 24,569,904 (24,537,968–24,594,624) | -11% |
| memory_outage | heap_at_end_bytes | 27,537,704 (27,525,960–27,551,544) | 24,538,008 (24,502,736–24,554,896) | -11% |
| memory_outage | growth_per_call_bytes | -3.81 (-5.46–-2.51) | -3.46 (-3.97–-2.7) | +0.351 (noise) |
| large_result | plain_p50_ms | 0.0297 (0.0292–0.0308) | 0.0297 (0.029–0.0299) | -0% (noise) |
| large_result | plain_p99_ms | 0.0885 (0.0831–0.0927) | 0.0817 (0.0752–0.0911) | -8% |
| large_result | baton_p50_ms | 0.255 (0.253–0.267) | 0.26 (0.257–0.267) | +2% (noise) |
| large_result | baton_p99_ms | 2.23 (2.2–2.35) | 2.39 (2.27–2.48) | +7% |
| large_result | added_p50_ms | 0.225 (0.223–0.236) | 0.231 (0.227–0.237) | +2% (noise) |
| large_result | added_p99_ms | 2.14 (2.11–2.25) | 2.3 (2.19–2.4) | +7% |
| large_result | heap_growth_bytes | 695,024 (692,696–720,704) | 711,984 (657,680–754,376) | +2% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 217,751,552 (217,370,624–225,583,104) | 202,407,936 (201,519,104–209,022,976) | -7% |
