"""Train and compare bot-reply classifiers on labelled X replies.

Protocol
- Threads are split into DEV and TEST (held out; never used for model or hyper-parameter choice).
- On DEV: leave-one-thread-out CV for every model -> pick the best.
- Report the chosen models once on TEST.
- Metric: recall on bots while hiding <= 1% (and 3%) of humans (human + low-quality human).

Models
  lr        logistic regression on hand features + Decisions probabilities
  mlp       small MLP on the same
  mlp_emb   MLP on hand features + Decisions + PCA(64) of OpenAI text embeddings (reply, and bio)
  ft        fine-tuned multilingual transformer (post/reply/account text) + hand features, on GPU

Usage: .venv/bin/python ml/train.py [--models lr,mlp,mlp_emb,ft] [--test]
"""
import argparse
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(__file__))
from features import features, account_summary, ts  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "eval", "data")
DEV = "cuda" if torch.cuda.is_available() else "cpu"


def load():
    data = json.load(open(os.path.join(ROOT, "dataset2.json")))
    labels = json.load(open(os.path.join(ROOT, "labels2.json")))          # id -> b/l/h/u
    split = json.load(open(os.path.join(ROOT, "split2.json")))            # {"test": [focal ids]}
    dec = json.load(open(os.path.join(ROOT, "cache2-dec_combo.json")))    # id -> {choice,text,acct}
    emb = np.load(os.path.join(ROOT, "emb2.npz"))                         # ids, reply, bio
    return data, labels, split, dec, emb


def logit(p):
    p = min(0.999, max(0.001, p))
    return math.log(p / (1 - p))


# ---------------- metrics
def auc(s, y):
    s, y = np.asarray(s), np.asarray(y)
    pos, neg = s[y == 1], s[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]))
    ranks = np.empty(len(order)); ranks[order] = np.arange(1, len(order) + 1)
    return (ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def recall_at_fpr(s, y, max_fpr):
    s, y = np.asarray(s), np.asarray(y)
    best = (0.0, 1.0, 0.0)
    for th in np.unique(s)[::-1]:
        pred = s >= th
        fpr = (pred & (y == 0)).sum() / max(1, (y == 0).sum())
        if fpr > max_fpr:
            break
        rec = (pred & (y == 1)).sum() / max(1, (y == 1).sum())
        prec = (pred & (y == 1)).sum() / max(1, pred.sum())
        if rec >= best[0]:
            best = (rec, th, prec)
    return best


# ---------------- models on tabular features
class MLP(nn.Module):
    def __init__(self, d, h=64, p=0.3):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d, h), nn.GELU(), nn.Dropout(p), nn.Linear(h, h // 2), nn.GELU(), nn.Dropout(p), nn.Linear(h // 2, 1))

    def forward(self, x):
        return self.net(x).squeeze(-1)


def fit_tab(Xtr, ytr, kind, seed=0, epochs=300):
    torch.manual_seed(seed)
    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-6
    X = torch.tensor((Xtr - mu) / sd, device=DEV)
    y = torch.tensor(ytr, dtype=torch.float32, device=DEV)
    model = (nn.Linear(X.shape[1], 1) if kind == "lr" else MLP(X.shape[1])).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-2 if kind == "lr" else 3e-3, weight_decay=1e-2 if kind == "lr" else 5e-2)
    pos_w = torch.tensor((1 - ytr.mean()) / max(ytr.mean(), 1e-3), device=DEV)
    lossf = nn.BCEWithLogitsLoss(pos_weight=pos_w)
    for _ in range(epochs):
        model.train(); opt.zero_grad()
        out = model(X) if kind != "lr" else model(X).squeeze(-1)
        lossf(out, y).backward(); opt.step()
    model.eval()

    def predict(Xte):
        with torch.no_grad():
            Z = torch.tensor((Xte - mu) / sd, device=DEV)
            out = model(Z) if kind != "lr" else model(Z).squeeze(-1)
            return torch.sigmoid(out).cpu().numpy()
    predict.model, predict.mu, predict.sd = model, mu, sd
    return predict


def ensemble(Xtr, ytr, kind, n=5):
    ms = [fit_tab(Xtr, ytr, kind, seed=s) for s in range(1 if kind == "lr" else n)]
    return lambda X: np.mean([m(X) for m in ms], axis=0)


# ---------------- fine-tuned transformer
FT_MODEL = os.environ.get("FT_MODEL", "intfloat/multilingual-e5-small")


def ft_texts(data, idx):
    now = ts(max(r["createdAt"] for r in data["replies"] if r.get("createdAt")))
    out = []
    for i in idx:
        r = data["replies"][i]
        p = data["posts"].get(r["focal"], {})
        out.append(f"query: post by {p.get('author', '')}: {(p.get('text') or '')[:300]}\nreply: {r['text'] or '[media only]'}\naccount: {account_summary(r['user'], now)}")
    return out


def fit_ft(data, tr_idx, ytr, Xtab_tr, epochs=4, seed=0):
    from transformers import AutoModel, AutoTokenizer
    torch.manual_seed(seed); random.seed(seed)
    tok = AutoTokenizer.from_pretrained(FT_MODEL)
    enc = AutoModel.from_pretrained(FT_MODEL).to(DEV)
    mu, sd = Xtab_tr.mean(0), Xtab_tr.std(0) + 1e-6
    head = nn.Sequential(nn.Linear(enc.config.hidden_size + Xtab_tr.shape[1], 128), nn.GELU(), nn.Dropout(0.2), nn.Linear(128, 1)).to(DEV)
    opt = torch.optim.AdamW([{"params": enc.parameters(), "lr": 3e-5}, {"params": head.parameters(), "lr": 1e-3}], weight_decay=0.01)
    pos_w = torch.tensor((1 - ytr.mean()) / max(ytr.mean(), 1e-3), device=DEV)
    lossf = nn.BCEWithLogitsLoss(pos_weight=pos_w)
    texts = ft_texts(data, tr_idx)
    Xt = (Xtab_tr - mu) / sd
    order = list(range(len(texts)))

    def fwd(batch_texts, xtab):
        b = tok(batch_texts, padding=True, truncation=True, max_length=192, return_tensors="pt").to(DEV)
        h = enc(**b).last_hidden_state
        m = b["attention_mask"].unsqueeze(-1).float()
        pooled = (h * m).sum(1) / m.sum(1)
        return head(torch.cat([pooled, torch.tensor(xtab, device=DEV)], -1)).squeeze(-1)

    for ep in range(epochs):
        random.shuffle(order); enc.train(); head.train()
        for k in range(0, len(order), 16):
            bi = order[k:k + 16]
            opt.zero_grad()
            loss = lossf(fwd([texts[i] for i in bi], Xt[bi]), torch.tensor(ytr[bi], dtype=torch.float32, device=DEV))
            loss.backward(); opt.step()
    enc.eval(); head.eval()

    def predict(te_idx, Xtab_te):
        tt, out = ft_texts(data, te_idx), []
        with torch.no_grad():
            for k in range(0, len(tt), 64):
                out.append(torch.sigmoid(fwd(tt[k:k + 64], (Xtab_te[k:k + 64] - mu) / sd)).cpu().numpy())
        return np.concatenate(out)
    return predict


# ---------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="lr,mlp,mlp_emb")
    ap.add_argument("--test", action="store_true", help="also evaluate on held-out TEST threads")
    args = ap.parse_args()
    data, labels, split, dec, emb = load()
    R = data["replies"]
    F, names = features(data)
    D = np.asarray([[logit(dec[r["id"]]["choice"]), logit(dec[r["id"]]["text"]), logit(dec[r["id"]]["acct"])] if r["id"] in dec else [0, 0, 0] for r in R], dtype=np.float32)
    eid = {k: i for i, k in enumerate(emb["ids"])}
    # PCA of embeddings fitted on ALL replies (unlabelled too): unsupervised, no label leakage
    def pca(M, k=64):
        Mc = M - M.mean(0)
        _, _, Vt = np.linalg.svd(Mc, full_matrices=False)
        return (Mc @ Vt[:k].T).astype(np.float32)
    E = np.concatenate([pca(emb["reply"]), pca(emb["bio"], 16)], 1)
    E = np.asarray([E[eid[r["id"]]] for r in R], dtype=np.float32)

    lab = [i for i, r in enumerate(R) if labels.get(r["id"]) in ("b", "l", "h") and r["id"] in dec]
    y_all = np.asarray([1.0 if labels.get(r["id"]) == "b" else 0.0 for r in R], dtype=np.float32)
    test_threads = set(split["test"])
    dev = [i for i in lab if R[i]["focal"] not in test_threads]
    test = [i for i in lab if R[i]["focal"] in test_threads]
    dev_threads = sorted({R[i]["focal"] for i in dev})
    print(f"device={DEV}  features={len(names)}  labelled dev={len(dev)} ({int(y_all[dev].sum())} bots, {len(dev_threads)} threads)  test={len(test)} ({int(y_all[test].sum())} bots, {len(test_threads)} threads)")

    inputs = {"lr": np.concatenate([F, D], 1), "mlp": np.concatenate([F, D], 1), "mlp_emb": np.concatenate([F, D, E], 1)}
    results = {}
    for m in args.models.split(","):
        t0 = time.time()
        scores = np.zeros(len(R), dtype=np.float32)
        for th in dev_threads:
            tr = [i for i in dev if R[i]["focal"] != th]
            te = [i for i in dev if R[i]["focal"] == th]
            if m == "ft":
                Xtab = np.concatenate([F, D], 1)
                pred = fit_ft(data, tr, y_all[tr], Xtab[tr])
                scores[te] = pred(te, Xtab[te])
            else:
                X = inputs[m]
                scores[te] = ensemble(X[tr], y_all[tr], "lr" if m == "lr" else "mlp")(X[te])
        s, yy = scores[dev], y_all[dev]
        r1, r3 = recall_at_fpr(s, yy, 0.01), recall_at_fpr(s, yy, 0.03)
        results[m] = (auc(s, yy), r1, r3)
        print(f"{m:8s} DEV leave-thread-out  AUC {auc(s, yy):.3f}  recall@1% {r1[0]*100:5.1f}% (th {r1[1]:.2f}, prec {r1[2]*100:.0f}%)  recall@3% {r3[0]*100:5.1f}%   [{time.time()-t0:.0f}s]")

    if args.test:
        print("\n--- held-out TEST threads (train on all DEV, pick threshold on DEV CV) ---")
        for m in args.models.split(","):
            if m == "ft":
                Xtab = np.concatenate([F, D], 1)
                st = fit_ft(data, dev, y_all[dev], Xtab[dev])(test, Xtab[test])
            else:
                X = inputs[m]
                st = ensemble(X[dev], y_all[dev], "lr" if m == "lr" else "mlp")(X[test])
            yt = y_all[test]
            th1 = results[m][1][1]
            pred = st >= th1
            fpr = (pred & (yt == 0)).sum() / max(1, (yt == 0).sum()); rec = (pred & (yt == 1)).sum() / max(1, (yt == 1).sum())
            print(f"{m:8s} TEST AUC {auc(st, yt):.3f} | at DEV's 1% threshold {th1:.2f}: recall {rec*100:.1f}%, people hidden {fpr*100:.1f}% | oracle recall@1% {recall_at_fpr(st, yt, 0.01)[0]*100:.1f}%")


if __name__ == "__main__":
    main()
