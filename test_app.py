"""Quick smoke tests that need NO database and NO Stripe account.

Run from the project folder:
    pip install pytest
    pytest -q
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.pop("DATABASE_URL", None)          # tests must never touch a real database
os.environ.setdefault("FLASK_ENV", "development")

import app as bluemart                       # noqa: E402


@pytest.fixture()
def client():
    bluemart.app.config["TESTING"] = True
    with bluemart.app.test_client() as c:
        yield c


def login_as(client, name="buyer1"):
    """Pretend a user is signed in and return the CSRF header they would send."""
    with client.session_transaction() as sess:
        sess["username"] = name
        sess["csrf_token"] = "test-token"
    return {"X-CSRF-Token": "test-token"}


# ---------- basics ----------

def test_home_page_renders_with_security_headers(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["X-Frame-Options"] == "DENY"
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]


def test_session_when_logged_out(client):
    r = client.get("/api/session")
    assert r.status_code == 200
    assert r.get_json()["logged_in"] is False


def test_unknown_api_route_returns_json_404(client):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.get_json()["success"] is False


# ---------- validation ----------

def test_register_rejects_short_password(client):
    r = client.post("/api/register", json={
        "username": "newuser", "password": "short", "email": "a@b.co",
        "accept_terms": True, "age_confirmed": True},
        environ_base={"REMOTE_ADDR": "10.0.0.1"})
    assert r.status_code == 422
    assert r.get_json()["success"] is False


def test_register_requires_terms_and_age(client):
    r = client.post("/api/register", json={
        "username": "newuser", "password": "longenough1", "email": "a@b.co",
        "accept_terms": False, "age_confirmed": True},
        environ_base={"REMOTE_ADDR": "10.0.0.2"})
    assert r.status_code == 422


def test_login_needs_a_json_body(client):
    r = client.post("/api/login", environ_base={"REMOTE_ADDR": "10.0.0.3"})
    assert r.status_code in (400, 415)


def test_shipping_schema_accepts_good_and_rejects_bad():
    schema = bluemart.ShippingSchema()
    ok = schema.load({"full_name": "Abel T", "phone": "+251911000000",
                      "address": "Bole Road 12", "city": "Addis Ababa", "country": "Ethiopia"})
    assert ok["region"] == "" and ok["notes"] == ""
    with pytest.raises(bluemart.ValidationError):
        schema.load({"full_name": "A", "phone": "1", "address": "x", "city": "", "country": ""})


# ---------- access control ----------

def test_cart_requires_login(client):
    assert client.get("/api/cart").status_code == 401


def test_state_changing_request_needs_csrf_token(client):
    login_as(client)
    r = client.delete("/api/cart/clear")                      # no X-CSRF-Token header
    assert r.status_code == 403


def test_checkout_requires_a_delivery_address(client):
    headers = login_as(client)
    r = client.post("/api/create-checkout-session", json={"shipping": {"full_name": "A"}}, headers=headers)
    assert r.status_code == 422                               # rejected before any stock is reserved


def test_message_body_is_required(client):
    headers = login_as(client)
    r = client.post("/api/orders/1/messages?seller=someone", json={"body": ""}, headers=headers)
    assert r.status_code in (400, 422)


# ---------- payments ----------

def test_stripe_webhook_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setattr(bluemart, "STRIPE_WEBHOOK_SECRET", "whsec_test")
    r = client.post("/api/stripe/webhook", data=b"{}", headers={"Stripe-Signature": "t=1,v1=bad"})
    assert r.status_code == 400


# ---------- rate limiting ----------

@pytest.mark.skipif(bluemart.limiter is None, reason="Flask-Limiter not installed")
def test_register_is_rate_limited(client):
    codes = [client.post("/api/register", json={}, environ_base={"REMOTE_ADDR": "10.9.9.9"}).status_code
             for _ in range(7)]
    assert 429 in codes
