import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

from backend.http_api import make_handler


class StoreStub:
    def __init__(self) -> None:
        self.setup_calls = 0
        self.verify_calls = 0
        self.allow_setup = True
        self.allow_login = False

    def set_access_password(self, scope: str, password: str) -> bool:
        self.setup_calls += 1
        return self.allow_setup

    def verify_access_password(self, scope: str, password: str) -> bool:
        self.verify_calls += 1
        return self.allow_login

    def create_access_session(self, scope: str) -> str:
        return "test-session-token"


class AccessAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = StoreStub()
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(self.store)
        )
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, action: str, password: str) -> tuple[int, dict[str, object]]:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        try:
            connection.request(
                "POST",
                f"/api/access/general/{action}",
                body=json.dumps({"password": password}),
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_setup_does_not_verify_the_password_a_second_time(self) -> None:
        self.store.allow_login = True

        status, payload = self.post("setup", "correct-horse")

        self.assertEqual(status, 200)
        self.assertTrue(payload["authenticated"])
        self.assertEqual(self.store.setup_calls, 1)
        self.assertEqual(self.store.verify_calls, 0)

    def test_rate_limited_setup_does_not_store_a_password(self) -> None:
        for _ in range(10):
            status, _ = self.post("login", "wrong-password")
            self.assertEqual(status, 401)

        status, _ = self.post("setup", "correct-horse")

        self.assertEqual(status, 429)
        self.assertEqual(self.store.setup_calls, 0)


if __name__ == "__main__":
    unittest.main()
