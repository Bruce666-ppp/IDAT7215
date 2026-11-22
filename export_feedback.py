"""Explicit local export; feedback is never silently treated as ground truth."""
import csv
import sqlite3
from core import BASE

def main():
    db=BASE/'data/pawthfinder.sqlite3'
    if not db.exists(): raise SystemExit('请先运行网页并收集反馈')
    out=BASE/'data/feedback.csv'
    with sqlite3.connect(db) as con:
        rows=con.execute('SELECT r.owner,r.profile,f.pet_id,f.rating FROM runs r JOIN feedback f ON r.id=f.run_id ORDER BY f.created_at')
        # Keep latest rating per session owner and pet. Require stable profile per owner for grouped training.
        latest={}; profiles={}
        for owner,profile,pet,rating in rows:
            if owner in profiles and profiles[owner]!=profile:
                raise SystemExit('同一会话存在不同问卷，请人工整理稳定用户资料后导出，未生成可训练数据。')
            profiles[owner]=profile; latest[(owner,pet)]=(profile,(rating-1)/4)
    temp=out.with_suffix('.tmp')
    with temp.open('w',encoding='utf-8',newline='') as f:
        w=csv.writer(f); w.writerow(['user_id','profile','pet_id','score'])
        for (owner,pet),(profile,score) in latest.items(): w.writerow([owner,profile,pet,score])
    temp.replace(out)
    print(f'已导出 {len(latest)} 条至 {out}；需人工检查标签、同意授权与采样偏差后再训练。')
if __name__=='__main__': main()
