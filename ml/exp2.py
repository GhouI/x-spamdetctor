"""Round 2 experiments on DEV threads (leave-one-thread-out). TEST threads untouched.
Adds: Fable's split predicates, cross-thread author count, gradient boosting, and a second
metric where only substantive humans count as people that must not be hidden."""
import json, os, sys, warnings
import numpy as np
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from features import features
from train import load, logit, auc, recall_at_fpr, ensemble

data, labels, split, dec, emb = load()
R = data["replies"]
ROOT = os.path.join(os.path.dirname(__file__), "..", "eval", "data")
dsplit = json.load(open(os.path.join(ROOT, "cache2-dec_split.json")))
F, names = features(data)
D = np.array([[logit(dec[r["id"]][k]) for k in ("choice", "text", "acct")] if r["id"] in dec else [0, 0, 0] for r in R], dtype=np.float32)
S = np.array([[logit(dsplit[r["id"]].get(k, 0.5)) for k in ("promo", "generic", "specific", "paraphrase", "acct")] if r["id"] in dsplit else [0] * 5 for r in R], dtype=np.float32)
dextra = json.load(open(os.path.join(ROOT, "cache2-dec_extra.json")))
X_extra = np.array([[logit(dextra[r["id"]].get(k, 0.5)) for k in ("praise_only", "bio_promo", "brand", "ai_style")] if r["id"] in dextra else [0] * 4 for r in R], dtype=np.float32)
dextra2 = json.load(open(os.path.join(ROOT, "cache2-dec_extra2.json")))
X_extra2 = np.array([[logit(dextra2[r["id"]].get(k, 0.5)) for k in ("off_topic", "self_promo", "flattery", "link_seller")] if r["id"] in dextra2 else [0] * 4 for r in R], dtype=np.float32)
threads_of = {}
for r in R:
    threads_of.setdefault(r["user"]["id"], set()).add(r["focal"])
X_multi = np.array([[min(len(threads_of[r["user"]["id"]]), 5)] for r in R], dtype=np.float32)
eid = {k: i for i, k in enumerate(emb["ids"])}
def pca(M, k):
    Mc = M - M.mean(0); _, _, Vt = np.linalg.svd(Mc, full_matrices=False); return (Mc @ Vt[:k].T).astype(np.float32)
E = np.concatenate([pca(emb["reply"], 32), pca(emb["bio"], 8)], 1)
E = np.array([E[eid[r["id"]]] for r in R], dtype=np.float32)

lab = {r["id"]: labels.get(r["id"]) for r in R}
test_threads = set(split["test"])
dev = [i for i, r in enumerate(R) if lab[r["id"]] in ("b", "l", "h") and r["focal"] not in test_threads and r["id"] in dsplit and r["id"] in dec]
y = np.array([1.0 if lab[r["id"]] == "b" else 0.0 for r in R], dtype=np.float32)
is_h = np.array([lab[r["id"]] == "h" for r in R])
dev_threads = sorted({R[i]["focal"] for i in dev})
print(f"DEV {len(dev)} labelled ({int(y[dev].sum())} bots) over {len(dev_threads)} threads\n")

def lgbm_fit(Xtr, ytr):
    import lightgbm as lgb
    ms = [lgb.LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=15, subsample=0.8, subsample_freq=1, colsample_bytree=0.7, reg_lambda=1.0, random_state=s, verbose=-1).fit(Xtr, ytr) for s in range(3)]
    return lambda X: np.mean([m.predict_proba(X)[:, 1] for m in ms], 0)

def run(name, X, kind):
    sc = np.zeros(len(R), dtype=np.float32)
    for th in dev_threads:
        tr = [i for i in dev if R[i]["focal"] != th]; te = [i for i in dev if R[i]["focal"] == th]
        f = lgbm_fit(X[tr], y[tr]) if kind == "gbm" else ensemble(X[tr], y[tr], kind)
        sc[te] = f(X[te])
    s, yy = sc[dev], y[dev]
    # metric 2: negatives = substantive humans only (low-quality humans neither counted nor penalised)
    keep = np.array([y[i] == 1 or is_h[i] for i in dev])
    a1, a3 = recall_at_fpr(s, yy, 0.01), recall_at_fpr(s, yy, 0.03)
    b1, b3 = recall_at_fpr(s[keep], yy[keep], 0.01), recall_at_fpr(s[keep], yy[keep], 0.03)
    print(f"{name:42s} AUC {auc(s, yy):.3f} | all people: {a1[0]*100:5.1f}% @1%  {a3[0]*100:5.1f}% @3% | real humans only: {b1[0]*100:5.1f}% @1%  {b3[0]*100:5.1f}% @3%")
    return sc

base = np.concatenate([F, D], 1)
full = np.concatenate([F, D, S, X_multi], 1)
full_x = np.concatenate([F, D, S, X_multi, X_extra], 1)
full_x2 = np.concatenate([F, D, S, X_multi, X_extra, X_extra2], 1)
if os.environ.get("EXTRA2"):
    run("GBM + extra questions (current best)", full_x, "gbm")
    run("GBM + extra + extra2 questions", full_x2, "gbm")
if os.environ.get("EXTRA"):
    run("GBM + split + multi (current best)", full, "gbm")
    run("GBM + split + multi + extra questions", full_x, "gbm")
    run("LR  + split + multi + extra questions", full_x, "lr")
if not os.environ.get("CURVE"): run("LR  features+combo (previous best)", base, "lr")
if not os.environ.get("CURVE"): run("LR  + split predicates + multi-thread", full, "lr")
if not os.environ.get("CURVE"): run("GBM features+combo", base, "gbm")
if not os.environ.get("CURVE"): run("GBM + split predicates + multi-thread", full, "gbm")
if not os.environ.get("CURVE"): run("GBM + split + multi + embeddings", np.concatenate([full, E], 1), "gbm")
if not os.environ.get("CURVE"): run("MLP + split + multi + embeddings", np.concatenate([full, E], 1), "mlp")

if os.environ.get("CURVE"):
    import random
    print("\nlearning curve (GBM + split + multi), leave-thread-out, training on a fraction of the OTHER threads' labels:")
    X = full
    for frac in (0.25, 0.5, 0.75, 1.0):
        rs = []
        for seed in range(3):
            rng = random.Random(seed); sc = np.zeros(len(R), dtype=np.float32)
            for th in dev_threads:
                tr = [i for i in dev if R[i]["focal"] != th]; tr = rng.sample(tr, int(len(tr) * frac))
                te = [i for i in dev if R[i]["focal"] == th]
                sc[te] = lgbm_fit(X[tr], y[tr])(X[te])
            s, yy = sc[dev], y[dev]; rs.append((auc(s, yy), recall_at_fpr(s, yy, 0.01)[0], recall_at_fpr(s, yy, 0.03)[0]))
        m = np.mean(rs, 0); print(f"  {frac:4.0%} of labels (~{int(len(dev)*frac*17/18)}): AUC {m[0]:.3f}  recall@1% {m[1]*100:.1f}%  recall@3% {m[2]*100:.1f}%")

if os.environ.get("ERRORS"):
    import datetime
    sc = np.zeros(len(R), dtype=np.float32)
    for th in dev_threads:
        tr = [i for i in dev if R[i]["focal"] != th]; te = [i for i in dev if R[i]["focal"] == th]
        sc[te] = lgbm_fit(full[tr], y[tr])(full[te])
    th1 = recall_at_fpr(sc[dev], y[dev], 0.01)[1]
    now = max(datetime.datetime.strptime(r["createdAt"], "%a %b %d %H:%M:%S %z %Y").timestamp() for r in R)
    def show(i):
        r = R[i]; u = r["user"]; d = max(1, (now - datetime.datetime.strptime(u["createdAt"], "%a %b %d %H:%M:%S %z %Y").timestamp()) / 86400)
        return f'{sc[i]:.2f} {lab[r["id"]]} {u["handle"][:16]:16s} {u["posts"]/d:5.0f}/d {u["followers"]:>7}/{u["following"]:<6} lk/post {u.get("likesGiven",0)/max(1,u["posts"]):.2f} | {(u.get("bio") or "")[:35]!r} | {r["text"][:80]!r}'
    missed = sorted([i for i in dev if y[i] == 1 and sc[i] < th1], key=lambda i: sc[i])
    print(f"threshold@1% = {th1:.2f}; missed bots: {len(missed)} of {int(y[dev].sum())}. Random 35 missed bots:")
    import random; random.Random(1).shuffle(missed)
    for i in missed[:35]: print("  ", show(i))
    fps = sorted([i for i in dev if y[i] == 0], key=lambda i: -sc[i])[:15]
    print("\nhighest-scored non-bots:")
    for i in fps: print("  ", show(i))

if os.environ.get("TEST"):
    test = [i for i, r in enumerate(R) if lab[r["id"]] in ("b", "l", "h") and r["focal"] in test_threads and r["id"] in dec]
    for name, X in (("GBM + split + multi (round-1 best)", full), ("GBM + all questions (final)", full_x2)):
        sc = np.zeros(len(R), dtype=np.float32)
        for th in dev_threads:   # dev CV scores -> choose thresholds without touching TEST
            tr = [i for i in dev if R[i]["focal"] != th]; te = [i for i in dev if R[i]["focal"] == th]
            sc[te] = (lgbm_fit if name.startswith("GBM") else (lambda a, b: ensemble(a, b, "lr")))(X[tr], y[tr])(X[te])
        keep_d = np.array([y[i] == 1 or is_h[i] for i in dev])
        th = {"all1": recall_at_fpr(sc[dev], y[dev], 0.01)[1], "all3": recall_at_fpr(sc[dev], y[dev], 0.03)[1],
              "hum1": recall_at_fpr(sc[dev][keep_d], y[dev][keep_d], 0.01)[1], "hum3": recall_at_fpr(sc[dev][keep_d], y[dev][keep_d], 0.03)[1]}
        f = (lgbm_fit if name.startswith("GBM") else (lambda a, b: ensemble(a, b, "lr")))(X[dev], y[dev])
        st = f(X[test]); yt = y[test]; ht = is_h[test]
        print(f"\n{name}: TEST {len(test)} replies, {int(yt.sum())} bots, {int(ht.sum())} real humans, {int(len(test)-yt.sum()-ht.sum())} low-effort humans; AUC {auc(st, yt):.3f}")
        for k, t in th.items():
            p = st >= t
            print(f"  threshold {t:.2f} ({k}): bots caught {p[yt==1].mean()*100:5.1f}%  | hidden: real humans {p[ht].mean()*100:4.1f}%, low-effort humans {p[(yt==0)&~ht].mean()*100:4.1f}%  | precision {(p&(yt==1)).sum()/max(1,p.sum())*100:.0f}%")
