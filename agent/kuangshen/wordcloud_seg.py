# -*- coding: utf-8 -*-
# 框神语录词云 - 分词与词频统计(jieba)
# 用法: python wordcloud_seg.py <语录.txt> <输出freq.json>
#   输入: 每行一条语录(已精筛)
#   输出: [{w, n}] 按 n 降序
# 过滤: 无中文的 token / 单字 / 纯数字 / 含 emoji / 停用词
import json, re, sys
import jieba

jieba.setLogLevel(60)  # 静默词典加载日志

CJK_RE = re.compile(r'[一-鿿]')
EMOJI_RE = re.compile(r'[\U0001F000-\U0001FAFF☀-➿️‍]|[←-⇿⬀-⯿ﾞﾟ]')
DIGIT_ONLY = re.compile(r'^\d+$')

# 停用词:功能词 + 高频填充(语气词类「哈哈/卧槽/牛逼」是框神个人特征,刻意保留)
STOPWORDS = set('''的 了 是 在 我 你 他 她 它 我们 你们 他们 咱们 自己 别人 这个 那个 这些 那些 一个 一下 一点
这 那 谁 什么 怎么 为什么 咋 干嘛 哪里 哪儿 啥 怎 吗 呢 吧 啊 呀 哦 喔 呃 嗯 嘛 哟 呗 咯 啦 啧 唉 嘿
也 都 就 还 又 再 很 太 真 好 挺 不 没 有 是 要 会 能 可 得 被 把 让 给 从 到 向 于 之 其 此 如 和 与 或 但 而
知道 觉得 感觉 以为 认为 意思 时候 东西 事情 现在 今天 明天 昨天 刚刚 已经 一直 然后 所以 因为 但是 不过 如果 比如
可以 应该 可能 还是 就是 不是 而且 反正 其实 真的 特别 非常 有点 有点 差不多 一样 一起 一下 怎么办 没想到 讲道理
行 可以 没问题 收到 明白 了解 知道 好的 没事 算了 好吧 确实 当然 谢谢 客气 草 我 操 了 额 哦哦 嗯嗯 吧 嘛 的 阿 哈
直接 好像 没有 不会 不能 两个 三个 这么 那种 这种 很多 看到 原来 一定 完全 主要 正常 发现 起来 只能 办法 有人 无法 最后 一把 后面 一般 一次 一张 厉害 的话 所有 其他 每个 真的 然后 所以 因为 觉得 知道 感觉 有点 就是 还是 真的
哎呀 比较 只有 还要 下来 一套 不带 顺带 出来 肯定 刚好 这样 晚上 我要 甚至 反正 其实 特别 非常 差不多 一样 一起 怎么办 没想到 讲道理'''.split())

# 笑声/感叹/语气爆发类(框神个人特征)——默认不进词云,聚焦话题词
# 环境变量 KEEP_LAUGHS=1 时保留(如:哈哈 卧槽 牛逼 啊啊啊 全都在图上)
LAUGHS = set('哈哈 哈哈哈 哈哈哈哈 呵呵 嘿嘿 嘻嘻 卧槽 我艹 我操 我靠 牛逼 尼玛 啊啊啊 啊啊 呜呜呜'.split())

KEEP_LAUGHS = sys.argv[3] == '1' if len(sys.argv) > 3 else False

def seg_line(line):
    out = []
    for tok in jieba.cut(line):
        t = tok.strip()
        if not t or not CJK_RE.search(t):
            # 纯 ASCII 词(≥3 字母,如 ygo/link);门槛在 main 里另设
            if re.fullmatch(r'[A-Za-z]{3,}', t):
                out.append(t.lower())
            continue
        if DIGIT_ONLY.match(t):
            continue
        if EMOJI_RE.search(t):
            continue
        if len(t) == 1:          # 单字多为语气/虚词,丢
            continue
        t = re.sub(r'[【】\[\]（）()《》「」、，。！？…～~·“”"\'\s]', '', t)
        if not t or t in STOPWORDS:
            continue
        if not KEEP_LAUGHS and t in LAUGHS:
            continue
        out.append(t)
    return out

def main():
    src, dst = sys.argv[1], sys.argv[2]
    counts = {}
    seqs = []                    # 每句过滤后的 token 序列(bigram 合并用)
    with open(src, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            toks = seg_line(line)
            seqs.append(toks)
            for w in toks:
                counts[w] = counts.get(w, 0) + 1
    # bigram 短语合并:相邻中文词对共现 ≥3 → 拼成 3~6 字短语(卡通+世界 → 卡通世界)
    PAIR_MIN = 3
    pairs = {}
    for toks in seqs:
        for a, b in zip(toks, toks[1:]):
            if not CJK_RE.search(a) or not CJK_RE.search(b):
                continue
            phrase = a + b
            if not (3 <= len(phrase) <= 6):
                continue
            pairs[phrase] = pairs.get(phrase, 0) + 1
    for phrase, n in pairs.items():
        if n >= PAIR_MIN:
            counts[phrase] = max(counts.get(phrase, 0), n)
    # 过滤:中文词 ≥2 次;纯 ASCII 词 ≥5 次(滤掉 weixin/https 等噪音,保住 link/combo 术语)
    def ok(w, n):
        return n >= 2 if CJK_RE.search(w) else n >= 5
    freq = sorted(({'w': w, 'n': n} for w, n in counts.items() if ok(w, n)),
                  key=lambda x: -x['n'])
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(freq, f, ensure_ascii=False)
    print(f'seg done: {len(freq)} words')

if __name__ == '__main__':
    main()
