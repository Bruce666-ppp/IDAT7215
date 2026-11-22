import csv
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime,timezone
from pathlib import Path
from flask import Flask,Response,jsonify,render_template,request,session
from werkzeug.middleware.proxy_fix import ProxyFix
from community import register_community
from core import ALLERGY_CAUTION,ALLERGY_OPTIONS,BASE,PETS,REAL_PETS,DEFAULT,INPUT_DIM,USER_KEYS
from decision import HTTP_STATUS,Status,decision
from training_lab import MAX_UPLOAD_BYTES, TrainingLab, template_csv

def create_app(db_path=None,engine=None):
    app=Flask(__name__)
    data_dir=Path(os.environ.get('PAWTH_DATA_DIR', BASE/'data'))
    db=Path(db_path) if db_path is not None else data_dir/'pawthfinder.sqlite3'
    db.parent.mkdir(parents=True,exist_ok=True)
    pages_origin=os.environ.get('PAWTH_PAGES_ORIGIN','').rstrip('/')
    require_model=os.environ.get('PAWTH_REQUIRE_MODEL')=='1'
    allow_training=os.environ.get('PAWTH_ALLOW_TRAINING','1')=='1'
    temporary_records=os.environ.get('PAWTH_TEMPORARY_RECORDS')=='1'
    if os.environ.get('PAWTH_BEHIND_PROXY')=='1':
        app.wsgi_app=ProxyFix(app.wsgi_app,x_proto=1)
    secret=os.environ.get('PAWTH_SECRET')
    if not secret:
        keyfile=db.parent/'.session_secret'
        try:
            with keyfile.open('x',encoding='utf-8') as f: f.write(secrets.token_hex(32))
            keyfile.chmod(0o600)
        except FileExistsError: pass
        secret=keyfile.read_text(encoding='utf-8').strip()
    app.config.update(SECRET_KEY=secret,
                      MAX_CONTENT_LENGTH=16384,SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Lax',
                      SESSION_COOKIE_SECURE=os.environ.get('PAWTH_SECURE_COOKIES')=='1')
    lab = TrainingLab(db.parent / 'training', engine)
    def connect():
        con=sqlite3.connect(str(db),timeout=10); con.execute('PRAGMA foreign_keys=ON'); return con
    with closing(connect()) as con, con:
        con.execute('PRAGMA journal_mode=WAL')
        con.executescript("""
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL,
        profile TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS feedback(run_id TEXT NOT NULL REFERENCES runs(id), pet_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), created_at TEXT NOT NULL,
        PRIMARY KEY(run_id,pet_id));
        """)
    def owner():
        if 'owner' not in session: session['owner']=str(uuid.uuid4())
        return session['owner']
    register_community(app, connect, owner)

    @app.before_request
    def check_request_origin():
        origin=request.headers.get('Origin')
        if (request.method not in ('GET','HEAD','OPTIONS') and request.path.startswith('/api/')
                and origin and origin != request.host_url.rstrip('/')):
            return jsonify(error='请从 Pico 应用页面提交请求。'),403

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['X-Frame-Options']='DENY'
        response.headers['Content-Security-Policy']="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
        response.headers['Cache-Control']='no-store'
        if request.path=='/api/health' and pages_origin:
            response.vary.add('Origin')
            if request.headers.get('Origin')==pages_origin:
                response.headers['Access-Control-Allow-Origin']=pages_origin
        return response
    @app.get('/')
    def index():
        owner()
        return render_template('index.html', allow_training=allow_training, temporary_records=temporary_records)
    @app.get('/api/health')
    def health():
        try:
            with closing(connect()) as con:
                con.execute('SELECT id FROM runs LIMIT 1').fetchone()
        except sqlite3.Error:
            app.logger.exception('Health check failed to read the SQLite database')
            return jsonify(status='unavailable',database='unavailable'),503
        recommender=lab.snapshot()
        model_loaded=recommender.model is not None
        return jsonify(status='ok' if model_loaded else 'degraded',database='ok',
                       model_loaded=model_loaded,mode=recommender.source,model_version=recommender.version), (
                           503 if require_model and not model_loaded else 200
                       )
    @app.get('/api/info')
    def info():
        recommender = lab.snapshot()
        return jsonify(defaults=DEFAULT,mode=recommender.source,status=recommender.status,pets=PETS,
                       model_version=recommender.version,allergy_notice=ALLERGY_CAUTION,
                       allergy_options=[{'id':key,'name':label} for key,label in ALLERGY_OPTIONS.items()])
    @app.post('/api/recommend')
    def recommend():
        if not request.is_json:
            return jsonify(decision(Status.INVALID_INPUT,'问卷须以 JSON 提交。',inference='SKIPPED_INVALID_INPUT')),415
        raw=request.get_json()
        try:
            result=lab.snapshot().recommend(raw,require_model=require_model)
        except Exception:
            app.logger.exception('Unexpected recommendation error')
            return jsonify(decision(Status.SYSTEM_ERROR,'暂时无法生成推荐，请稍后重试。',inference='FAILED')),503
        if result['recommendation_status'] in HTTP_STATUS:
            return jsonify(result),HTTP_STATUS[result['recommendation_status']]
        run_id=str(uuid.uuid4())
        with closing(connect()) as con, con:
            con.execute('INSERT INTO runs VALUES (?,?,?,?,?)',(run_id,owner(),datetime.now(timezone.utc).isoformat(),
                json.dumps(result['input_summary'],ensure_ascii=False),json.dumps(result,ensure_ascii=False)))
        return jsonify(run_id=run_id,**result)
    @app.post('/api/feedback')
    def feedback():
        if not request.is_json: return jsonify(error='需要 application/json'),415
        body=request.get_json()
        if not isinstance(body,dict): return jsonify(error='请求必须是对象'),400
        run_id=body.get('run_id'); pet_id=body.get('pet_id'); rating=body.get('rating')
        if type(rating) is not int or not 1<=rating<=5 or not isinstance(run_id,str) or not isinstance(pet_id,str):
            return jsonify(error='run_id、pet_id 与 1–5 整数评分必填'),400
        with closing(connect()) as con, con:
            row=con.execute('SELECT result FROM runs WHERE id=? AND owner=?',(run_id,owner())).fetchone()
            if row is None: return jsonify(error='找不到本会话推荐记录'),404
            allowed={p['id'] for p in json.loads(row[0])['recommendations']}
            if pet_id not in allowed: return jsonify(error='只能评价该次推荐中的宠物'),400
            con.execute('INSERT OR REPLACE INTO feedback VALUES (?,?,?,?)',
                        (run_id,pet_id,rating,datetime.now(timezone.utc).isoformat()))
        return jsonify(ok=True)
    @app.get('/api/history')
    def history():
        with closing(connect()) as con:
            rows=con.execute('SELECT id,created_at,profile,result FROM runs WHERE owner=? ORDER BY created_at DESC LIMIT 20',(owner(),)).fetchall()
        return jsonify(items=[dict(run_id=r[0],created_at=r[1],profile=json.loads(r[2]),
            count=len(json.loads(r[3])['recommendations']),
            top=(json.loads(r[3])['recommendations'] or [None])[0],mode=json.loads(r[3])['mode']) for r in rows])
    @app.get('/api/history/<run_id>')
    def history_detail(run_id):
        with closing(connect()) as con:
            r=con.execute('SELECT created_at,profile,result FROM runs WHERE id=? AND owner=?',(run_id,owner())).fetchone()
            if r is None: return jsonify(error='找不到本会话记录'),404
            ratings=dict(con.execute('SELECT pet_id,rating FROM feedback WHERE run_id=?',(run_id,)).fetchall())
        return jsonify(run_id=run_id,created_at=r[0],profile=json.loads(r[1]),ratings=ratings,**json.loads(r[2]))
    @app.post('/api/scenario')
    def scenario():
        if not request.is_json: return jsonify(error='需要 application/json'),415
        body=request.get_json()
        if not isinstance(body,dict) or set(body)!={'before','after'}: return jsonify(error='需要 before 与 after 完整问卷'),400
        recommender = lab.snapshot()
        before=recommender.recommend(body['before'],require_model=require_model)
        after=recommender.recommend(body['after'],require_model=require_model)
        for result in (before,after):
            if result['recommendation_status'] in HTTP_STATUS:
                return jsonify(result),HTTP_STATUS[result['recommendation_status']]
        def lookup(result):
            return {p['id']:p for p in result['recommendations']+result['excluded']}
        b,a=lookup(before),lookup(after)
        changes=[]
        for p in REAL_PETS:
            old,new=b[p['id']],a[p['id']]
            changes.append(dict(id=p['id'],name=p['name'],before=old.get('score'),after=new.get('score'),
                delta=round(new['score']-old['score'],1) if old['eligible'] and new['eligible'] else None,
                state='新增合格' if not old['eligible'] and new['eligible'] else '不再合格' if old['eligible'] and not new['eligible'] else '仍然合格' if new['eligible'] else '仍不合格',
                blocked=new['blocked']))
        return jsonify(changes=changes,before_count=len(before['recommendations']),after_count=len(after['recommendations']),mode=recommender.source)
    @app.get('/api/model')
    def model_info():
        recommender = lab.snapshot()
        return jsonify(mode=recommender.source,status=recommender.status,architecture=[INPUT_DIM,64,32,16,1],
            user_feature_count=len(USER_KEYS),model_version=recommender.version,dataset_name=recommender.dataset_name,
            parameter_count=sum(p.numel() for p in recommender.model.parameters()) if recommender.model is not None else None,
            metrics=recommender.metrics,dataset_sha256=recommender.dataset_sha256,
            notice='图表与当前模型文件经指纹核对，训练、验证和测试按用户隔离。')
    @app.get('/api/training/template')
    def training_template():
        return Response('\ufeff' + template_csv(), mimetype='text/csv',
                        headers={'Content-Disposition': 'attachment; filename="pico-ratings-example.csv"'})
    @app.post('/api/training/preview')
    def training_preview():
        if not allow_training:
            return jsonify(error='当前服务开放随附模型的推理和图表。请在本地模型实验室上传训练数据。'),403
        request.max_content_length = MAX_UPLOAD_BYTES
        upload = request.files.get('dataset')
        if upload is None or not upload.filename or not upload.filename.lower().endswith('.csv'):
            return jsonify(error='请选择评分 CSV 文件'), 400
        try:
            return jsonify(lab.preview(owner(), upload))
        except UnicodeError:
            return jsonify(error='请将 CSV 另存为 UTF-8 编码后上传'), 400
        except (ValueError, csv.Error) as error:
            return jsonify(error=str(error)), 400
    @app.post('/api/training/<job_id>/start')
    def training_start(job_id):
        if not allow_training:
            return jsonify(error='当前服务开放随附模型的推理和图表。请在本地模型实验室训练新模型。'),403
        if not request.is_json:
            return jsonify(error='需要 application/json'), 415
        try:
            return jsonify(lab.start(owner(), job_id)), 202
        except LookupError as error:
            return jsonify(error=str(error)), 404
        except (RuntimeError, ValueError, OSError) as error:
            return jsonify(error=str(error)), 409
    @app.get('/api/training/<job_id>')
    def training_status(job_id):
        job = lab.get(owner(), job_id)
        return jsonify(job) if job else (jsonify(error='本会话没有这次训练'), 404)
    @app.errorhandler(400)
    def bad_request(e):
        if request.endpoint=='recommend':
            return jsonify(decision(Status.INVALID_INPUT,'问卷须为有效的 JSON 对象。',inference='SKIPPED_INVALID_INPUT')),400
        return jsonify(error='请求不是有效 JSON'),400
    @app.errorhandler(413)
    def too_large(e):
        if request.endpoint=='recommend':
            return jsonify(decision(Status.INVALID_INPUT,'问卷数据超过允许大小。',inference='SKIPPED_INVALID_INPUT')),413
        return jsonify(error='请求过大'),413
    @app.errorhandler(sqlite3.OperationalError)
    def database_unavailable(error):
        app.logger.error('SQLite error while handling a request',exc_info=error)
        if request.endpoint=='recommend':
            return jsonify(decision(Status.SYSTEM_ERROR,'暂时无法保存推荐记录，请稍后重试。')),503
        return jsonify(error='暂时无法读取或保存记录，请稍后重试。'),503
    return app
if __name__=='__main__':
    create_app().run(host='127.0.0.1',port=int(os.environ.get('PORT','8050')),debug=False)
