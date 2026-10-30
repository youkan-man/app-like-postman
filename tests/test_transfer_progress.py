"""Progress telemetry must not alter transfer semantics, retention or cleanup."""
import io
import threading
import time
import unittest

from test_upload_stream import app, server, http_json, QuietApp, DigestHandler
from upload_stream import Upload, UploadStore, StreamBody, IO_BYTES


class TransferProgressTests(unittest.TestCase):
    def setUp(self):
        self.prior = app.UPLOADS
        app.UPLOADS = UploadStore()
        self.proxy = server(QuietApp)
        self.target = server(DigestHandler)
        DigestHandler.waiting.clear(); DigestHandler.release.clear(); DigestHandler.records.clear()

    def tearDown(self):
        DigestHandler.release.set()
        for instance in (self.proxy, self.target):
            instance.shutdown(); instance.server_close()
        app.UPLOADS.close(); app.UPLOADS = self.prior

    def call(self, method, path, data=None, headers=None):
        return http_json(self.proxy.server_port, method, path, data, headers)

    def stage(self, data):
        status, created = self.call('POST', '/api/uploads', {'sizes':[len(data)]})
        self.assertEqual(status, 201); self.assertTrue(created['progress'])
        token = created['upload_id']
        if data:
            status, _ = self.call('POST', f'/api/uploads/{token}/0', data,
                {'Content-Type':'application/octet-stream','X-MiniPost-Offset':'0'})
            self.assertEqual(status, 200)
        return token

    def test_progress_is_read_only_metadata_and_cross_origin_is_rejected(self):
        token = self.stage(b'abc'); upload = app.UPLOADS.get(token)
        touched = upload.touched
        path = '/api/uploads/'+token+'/progress'
        status, result = self.call('GET', path)
        self.assertEqual(status, 200)
        self.assertEqual(set(result['progress']), {'phase','completed','total','attempt'})
        self.assertEqual(upload.touched, touched)
        self.assertEqual(self.call('GET',path,headers={'Origin':'https://other.test'})[0], 403)
        self.assertEqual(self.call('GET','/api/uploads/'+'0'*64+'/progress')[0], 404)

    def test_live_response_wait_is_not_a_terminal_success_and_consumption_removes_status(self):
        token = self.stage(b'\0\xffabc'); results=[]
        worker = threading.Thread(target=lambda:results.append(self.call('POST','/api/request',{
            'url':f'http://127.0.0.1:{self.target.server_port}/wait','method':'PUT',
            'upload_id':token,'body_upload':0,'timeout_ms':0})))
        worker.start(); self.assertTrue(DigestHandler.waiting.wait(3))
        status, result = self.call('GET','/api/uploads/'+token+'/progress')
        self.assertEqual(status, 200)
        self.assertEqual(result['progress'],{'phase':'waiting','completed':5,'total':5,'attempt':1})
        self.assertTrue(worker.is_alive())
        DigestHandler.release.set();worker.join(3)
        self.assertFalse(worker.is_alive()); self.assertEqual(results[0][0],200)
        self.assertEqual(self.call('GET','/api/uploads/'+token+'/progress')[0],404)

    def test_stream_counts_framing_and_file_bytes_and_redirect_restarts_attempt(self):
        upload = Upload([2*IO_BYTES+3]); payload=b'x'*(2*IO_BYTES+3)
        upload.append(0,0,len(payload),io.BytesIO(payload))
        body = StreamBody(upload,[b'header',0,b'tail']); counts=[]
        class Connection:
            sock=None
            def endheaders(self): pass
            def send(self,data): counts.append((len(data),upload.progress()['completed']))
        try:
            upload.begin_send(len(body));body.send(Connection())
            self.assertEqual(upload.progress()['completed'],len(body))
            self.assertEqual(sum(length for length,_ in counts),len(body))
            self.assertTrue(all(length<=IO_BYTES for length,_ in counts))
            upload.wait_response();self.assertEqual(upload.progress()['phase'],'waiting')
            upload.begin_send(len(body));self.assertEqual(upload.progress()['completed'],0)
            self.assertEqual(upload.progress()['attempt'],2)
            body.send(Connection());self.assertEqual(upload.progress()['completed'],len(body))
        finally:upload.close()

    def test_failed_socket_write_is_not_counted_as_sent(self):
        upload=Upload([0]);body=StreamBody(upload,[b'a'*(IO_BYTES+1)])
        class Connection:
            sock=None
            calls=0
            def endheaders(self): pass
            def send(self,data):
                self.calls+=1
                if self.calls==2:raise OSError('connection lost')
        try:
            upload.begin_send(len(body))
            with self.assertRaises(OSError):body.send(Connection())
            self.assertEqual(upload.progress()['completed'],IO_BYTES)
            self.assertLess(upload.progress()['completed'],upload.progress()['total'])
        finally:upload.close()

    def test_progress_read_does_not_wait_on_io_lock(self):
        upload=Upload([1]);holding=threading.Event();release=threading.Event()
        def hold():
            with upload.lock:holding.set();release.wait(3)
        worker=threading.Thread(target=hold);worker.start();self.assertTrue(holding.wait(1))
        try:
            started=time.monotonic();self.assertEqual(upload.progress()['phase'],'upload')
            self.assertLess(time.monotonic()-started,.2)
        finally:release.set();worker.join();upload.close()

if __name__=='__main__':unittest.main()
