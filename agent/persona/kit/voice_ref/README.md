# 贝利亚 / 可莉参考音频(仅作本地音色克隆参考)

- `belial_zh.mp3`: 6.05 秒,中文贝利亚配音对比片段,截取自 B 站 `BV1rxSBYVEZY` 的 7.2s–13.2s,已做响度归一化、24kHz 单声道 128kbps。
- `klee_zh.mp3`: 3.41 秒,中文可莉语音「早安!带可莉出去玩吧!我们一起来冒险!」,来自 Biligame 原神 Wiki 的可莉语音页,已做响度归一化、24kHz 单声道 128kbps。
- `laomushi_ref.wav`: 4.06 秒,老牧师红肠口音参考音频,来自 GitHub `cubk1/laomushi-tts` 的 `ref/ref.wav`(该仓库的 GPT-SoVITS 参考音频),32kHz 单声道 16-bit。
- 用途:给 MiMo `mimo-v2.5-tts-voiceclone` 做 few-shot 音色参考;不是训练数据,也不随语音输出分发。
- 想换声线:直接替换文件,或在 `agent/.env` 里设 `MIMO_BELIAL_REF` / `MIMO_KLEE_REF` / `MIMO_LAOMUSHI_REF`;语音缓存会按参考音频的 mtime 自动换 key。
