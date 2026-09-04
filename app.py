import resend
import secrets
import datetime
import cloudinary
import cloudinary.uploader
import os
import logging
import math
import stripe
from decimal import Decimal
from contextlib import contextmanager
from functools import wraps

from flask import Flask, render_template, request, jsonify, session
from markupsafe import escape
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import pool
from werkzeug.security import generate_password_hash, check_password_hash
from marshmallow import Schema, fields, ValidationError, validate

cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET")
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY")
if not FLASK_SECRET_KEY:
    # Never use a predictable production secret. A random fallback keeps local
    # development working, but sessions will reset when the process restarts.
    FLASK_SECRET_KEY = secrets.token_hex(32)
    logger.warning("FLASK_SECRET_KEY is not set; using a temporary random secret. Set it in production.")
app.secret_key = FLASK_SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB request limit

BASE_URL = (os.getenv("BASE_URL") or "").strip().rstrip("/")
RESEND_API_KEY = (os.getenv("RESEND_API_KEY") or "").strip()
resend.api_key = RESEND_API_KEY or None

STRIPE_SECRET_KEY = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
STRIPE_WEBHOOK_SECRET = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
stripe.api_key = STRIPE_SECRET_KEY or None

MIN_PASSWORD_LENGTH = 6
MAX_USERNAME_LENGTH = 100
MAX_PRODUCT_NAME_LENGTH = 255
ALLOWED_PRODUCT_CATEGORIES = [
    "Electronics", "Clothing", "Food", "Books", "Furniture", "Other"
]
USERNAME_PATTERN = r'^[a-zA-Z0-9_]{3,100}$'

# Account lockout policy - a standard defense against password guessing
# that most established platforms apply.
MAX_FAILED_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 15

DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None


def send_verification_email(email, username, verification_token):
    try:
        if not BASE_URL:
            logger.error("BASE_URL is not configured; cannot create verification URL.")
            return False
        if not RESEND_API_KEY:
            logger.error("RESEND_API_KEY is not configured; cannot send verification email.")
            return False

        verification_url = f"{BASE_URL}/verify-email/{verification_token}"

        params = {
            "from": "BlueMart <onboarding@resend.dev>",
            "to": [email],
            "subject": "Verify your BlueMart account",
            "html": f"""
                <h2>Welcome to BlueMart, {username}!</h2>

                <p>Thanks for creating your account.</p>

                <p>Please click the button below to verify your email address:</p>

                <p>
                    <a href="{verification_url}"
                       style="
                       display:inline-block;
                       padding:12px 20px;
                       background:#5bc0be;
                       color:#0b1329;
                       text-decoration:none;
                       border-radius:6px;
                       font-weight:bold;">
                        Verify My Account
                    </a>
                </p>

                <p>If you didn't create this account, you can ignore this email.</p>
            """
        }

        print("=== RESEND: ABOUT TO SEND EMAIL ===")
        print(f"Recipient: {email}")
        logger.debug("Verification email prepared for %s", email)

        response = resend.Emails.send(params)

        print("=== RESEND RESPONSE ===")
        print(response)

        logger.info(f"Verification email sent to {email}")

        return True

    except Exception as e:
        print("=== RESEND ERROR ===")
        print(type(e).__name__)
        print(str(e))

        logger.exception("Failed to send verification email")

        return False


def send_order_confirmation_email(email, username, order_id, total):
    try:
        if not BASE_URL or not RESEND_API_KEY:
            logger.error("Email configuration missing; cannot send order confirmation.")
            return False

        params = {
            "from": "BlueMart <onboarding@resend.dev>",
            "to": [email],
            "subject": f"BlueMart Order #{order_id} confirmed",
            "html": f"""
                <h2>Thank you, {escape(username)}!</h2>
                <p>Your BlueMart order <strong>#{order_id}</strong> has been confirmed.</p>
                <p><strong>Total paid:</strong> ${total:.2f}</p>
                <p>We appreciate your order.</p>
            """
        }
        response = resend.Emails.send(params)
        logger.info("Order confirmation email sent for order %s: %s", order_id, response)
        return True
    except Exception as e:
        logger.exception("Failed to send order confirmation email for order %s: %s", order_id, e)
        return False


def init_connection_pool():
    global db_pool
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL environment variable is missing.")
    try:
        db_pool = psycopg2.pool.SimpleConnectionPool(1, 20, DATABASE_URL)
        logger.info("Database connection pool initialized.")
    except Exception as e:
        logger.error(f"Failed to initialize connection pool: {e}")
        raise

@contextmanager
def get_db_connection():
    global db_pool
    if not db_pool:
        init_connection_pool()
    conn = db_pool.getconn()
    try:
        yield conn
    except Exception as e:
        conn.rollback()
        logger.error(f"Database error: {e}")
        raise
    finally:
        db_pool.putconn(conn)

def init_db():
    if not DATABASE_URL:
        logger.error("DATABASE_URL is missing.")
        return

    try:
        if db_pool is None:
            init_connection_pool()

        with get_db_connection() as conn:
            cur = conn.cursor()

            logger.info("DATABASE BOOT: Checking database structure...")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    username VARCHAR(100) PRIMARY KEY,
                    password_hash VARCHAR(255) NOT NULL,
                    email VARCHAR(255),
                    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    verification_token VARCHAR(255),
                    failed_login_attempts INT NOT NULL DEFAULT 0,
                    locked_until TIMESTAMP
                );
            """)

            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255);")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;")

            # Email had no uniqueness check at all before this - two accounts
            # could silently share the same address. Postgres allows multiple
            # NULLs under a UNIQUE constraint, so this is safe to add even if
            # older rows have no email yet.
            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'users_email_unique'
                    ) THEN
                        ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
                    END IF;
                END
                $$;
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS products (
                    id SERIAL PRIMARY KEY,
                    product_name VARCHAR(255) NOT NULL,
                    price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
                    category VARCHAR(100),
                    quantity INT NOT NULL DEFAULT 0,
                    seller_username VARCHAR(100),
                    image_url TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(product_name, seller_username),
                    FOREIGN KEY (seller_username) REFERENCES users(username) ON DELETE CASCADE
                );
            """)

            cur.execute("""
                ALTER TABLE products
                ADD COLUMN IF NOT EXISTS image_url TEXT;
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_products_seller 
                ON products(seller_username);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_products_name 
                ON products(LOWER(product_name));
            """)

            # Shopping cart
            cur.execute("""
                CREATE TABLE IF NOT EXISTS cart_items (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(100) NOT NULL,
                    product_id INT NOT NULL,
                    quantity INT NOT NULL DEFAULT 1,
                    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                    UNIQUE(username, product_id),
                    CHECK (quantity > 0)
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_cart_username ON cart_items(username);")

            # Orders store the checkout-level information.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS orders (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(100) NOT NULL,
                    total_amount NUMERIC(10, 2) NOT NULL,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid',
                    stripe_session_id VARCHAR(255) UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_orders_username ON orders(username);")

            # Order items keep a price/name snapshot so old orders do not change
            # when the product is later edited. product_id can become NULL if a
            # product is deleted after the order.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS order_items (
                    id SERIAL PRIMARY KEY,
                    order_id INT NOT NULL,
                    product_id INT,
                    product_name VARCHAR(255) NOT NULL,
                    price NUMERIC(10, 2) NOT NULL,
                    quantity INT NOT NULL,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
                    CHECK (quantity > 0)
                );
            """)

            # Newsletter / opt-in subscribers
            cur.execute("""
                CREATE TABLE IF NOT EXISTS newsletter_subscribers (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            conn.commit()
            cur.close()

            logger.info("DATABASE BOOT: Database structure is ready!")

    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        raise


# --- VALIDATION SCHEMAS ---
class RegisterSchema(Schema):
    username = fields.Str(
        required=True,
        validate=[
            validate.Length(min=3, max=MAX_USERNAME_LENGTH),
            validate.Regexp(USERNAME_PATTERN, error="Username can only contain letters, numbers, and underscores.")
        ]
    )
    password = fields.Str(required=True, validate=validate.Length(min=MIN_PASSWORD_LENGTH))
    email = fields.Email(required=True)

class LoginSchema(Schema):
    username = fields.Str(required=True)
    password = fields.Str(required=True)

class ResendVerificationSchema(Schema):
    username = fields.Str(required=True)

class ProductSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=MAX_PRODUCT_NAME_LENGTH))
    price = fields.Float(required=True, validate=validate.Range(min=0))
    category = fields.Str(required=True, validate=validate.OneOf(ALLOWED_PRODUCT_CATEGORIES))
    quantity = fields.Int(required=True, validate=validate.Range(min=0))

class EditProductSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=MAX_PRODUCT_NAME_LENGTH))
    price = fields.Float(allow_none=True, validate=validate.Range(min=0))
    category = fields.Str(allow_none=True, validate=validate.OneOf(ALLOWED_PRODUCT_CATEGORIES))
    quantity = fields.Int(allow_none=True, validate=validate.Range(min=0))

class SellProductSchema(Schema):
    name = fields.Str(required=True)
    quantity = fields.Int(required=True, validate=validate.Range(min=1))

class RestockProductSchema(Schema):
    name = fields.Str(required=True)
    quantity = fields.Int(required=True, validate=validate.Range(min=1))

class DeleteProductSchema(Schema):
    name = fields.Str(required=True)


class AddToCartSchema(Schema):
    product_id = fields.Int(required=True, validate=validate.Range(min=1))
    quantity = fields.Int(required=True, validate=validate.Range(min=1))


class UpdateCartSchema(Schema):
    product_id = fields.Int(required=True, validate=validate.Range(min=1))
    quantity = fields.Int(required=True, validate=validate.Range(min=1))


class NewsletterSchema(Schema):
    email = fields.Email(required=True)


def validate_json(schema_class):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            try:
                data = request.get_json()
                if not data:
                    return api_error("Invalid or missing JSON body.", 400)
                schema = schema_class()
                validated_data = schema.load(data)
                request.validated_data = validated_data
            except ValidationError as err:
                logger.warning(f"Validation error in {f.__name__}: {err.messages}")
                # Surface the first concrete field error so the person sees
                # something actionable instead of a generic message.
                first_error = next(iter(err.messages.values()))
                first_message = first_error[0] if isinstance(first_error, list) else str(first_error)
                return api_error(first_message, 422, errors=err.messages)
            except Exception as e:
                logger.error(f"Error in validate_json: {e}")
                return api_error("We couldn't process that request.", 400)
            return f(*args, **kwargs)
        return decorated_function
    return decorator

def require_login(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            return api_error("Please sign in to continue.", 401)
        return f(*args, **kwargs)
    return decorated_function


def api_ok(message, status=200, **extra):
    """Consistent shape for every successful API response."""
    return jsonify({"success": True, "message": message, **extra}), status


def api_error(message, status=400, **extra):
    """Consistent shape for every failed API response."""
    return jsonify({"success": False, "message": message, **extra}), status


@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; "
        "script-src 'self' 'unsafe-inline' https://js.stripe.com; connect-src 'self' https:; "
        "frame-src 'self' https://js.stripe.com https://checkout.stripe.com; font-src 'self' https: data:"
    )
    return response


class Useraccount:
    def __init__(self, username):
        self.username = username
        self.password_hash = None
        self.email = None
        self.email_verified = False
        self.failed_login_attempts = 0
        self.locked_until = None
        self.is_new = True

        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                cur.execute(
                    """SELECT password_hash, email, email_verified, failed_login_attempts, locked_until
                       FROM users WHERE username = %s;""",
                    (self.username,)
                )
                row = cur.fetchone()
                if row:
                    (self.password_hash, self.email, self.email_verified,
                     self.failed_login_attempts, self.locked_until) = row
                    self.is_new = False
                cur.close()
        except Exception as e:
            logger.error(f"Error retrieving user {self.username}: {e}")
            raise

    def set_password(self, password_input, email):
        """Create a new user with a hashed password and email verification token."""
        if not self.is_new:
            return False, "That username is already taken."
        if len(password_input) < MIN_PASSWORD_LENGTH:
            return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters."

        try:
            password_hash = generate_password_hash(password_input, method='pbkdf2:sha256')
            verification_token = secrets.token_urlsafe(32)

            with get_db_connection() as conn:
                cur = conn.cursor()
                cur.execute(
                    """INSERT INTO users
                       (username, password_hash, email, email_verified, verification_token)
                       VALUES (%s, %s, %s, %s, %s);""",
                    (self.username, password_hash, email, False, verification_token)
                )
                conn.commit()
                cur.close()

            self.password_hash = password_hash
            self.is_new = False

            logger.info(f"Account created for user: {self.username}")
            return True, verification_token

        except psycopg2.IntegrityError as e:
            logger.warning(f"Duplicate account attempt for {self.username}: {e}")
            constraint = getattr(getattr(e, 'diag', None), 'constraint_name', '') or ''
            if 'email' in constraint:
                return False, "That email is already registered. Try signing in instead."
            return False, "That username is already taken."

        except Exception as e:
            logger.error(f"Error creating account for {self.username}: {e}")
            return False, "We couldn't create your account right now. Please try again."

    def verify_password(self, password_input):
        now = datetime.datetime.utcnow()

        # Deliberately identical wording whether the username exists or the
        # password is wrong - real platforms never reveal which one failed,
        # since that lets an attacker enumerate valid usernames.
        generic_failure = "Invalid username or password."

        if self.password_hash is None:
            return False, generic_failure

        if self.locked_until and self.locked_until > now:
            minutes_left = max(1, int((self.locked_until - now).total_seconds() // 60) + 1)
            logger.warning(f"Login blocked - account locked: {self.username}")
            return False, f"Too many failed attempts. Try again in {minutes_left} minute(s)."

        if not check_password_hash(self.password_hash, password_input):
            self._record_failed_attempt()
            logger.warning(f"Failed login attempt for user: {self.username}")
            return False, generic_failure

        if not self.email_verified:
            logger.info(f"Login blocked - email not verified: {self.username}")
            return False, "Please verify your email before signing in. Check your inbox for the verification link."

        self._reset_failed_attempts()
        logger.info(f"User {self.username} logged in successfully.")
        return True, "Signed in successfully."

    def _record_failed_attempt(self):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                new_count = self.failed_login_attempts + 1
                if new_count >= MAX_FAILED_LOGIN_ATTEMPTS:
                    lock_time = datetime.datetime.utcnow() + datetime.timedelta(minutes=LOCKOUT_DURATION_MINUTES)
                    cur.execute(
                        "UPDATE users SET failed_login_attempts = %s, locked_until = %s WHERE username = %s;",
                        (new_count, lock_time, self.username)
                    )
                    logger.warning(f"Account locked after {new_count} failed attempts: {self.username}")
                else:
                    cur.execute(
                        "UPDATE users SET failed_login_attempts = %s WHERE username = %s;",
                        (new_count, self.username)
                    )
                conn.commit()
                cur.close()
        except Exception as e:
            logger.error(f"Failed to record failed login attempt for {self.username}: {e}")

    def _reset_failed_attempts(self):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                cur.execute(
                    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE username = %s;",
                    (self.username,)
                )
                conn.commit()
                cur.close()
        except Exception as e:
            logger.error(f"Failed to reset login attempts for {self.username}: {e}")


class ProductManager:
    def add_product(self, product_name, price, category, quantity, seller_username, image_url=None):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()

                cur.execute(
                    "SELECT id, quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);",
                    (product_name,)
                )
                row = cur.fetchone()

                if row:
                    _, existing_qty, existing_seller = row
                    if existing_seller != seller_username:
                        return False, "A product with this name is already listed by another seller."

                    new_qty = existing_qty + int(quantity)
                    cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                    conn.commit()
                    cur.close()
                    logger.info(f"Product {product_name} restocked by {seller_username}. New qty: {new_qty}")
                    return True, f"Product already listed. Quantity increased to {new_qty}."

                cur.execute(
                    """INSERT INTO products
                    (product_name, price, category, quantity, seller_username, image_url)
                     VALUES (%s, %s, %s, %s, %s, %s);""",
                  (
                     product_name,
                     float(price),
                     category,
                     int(quantity),
                     seller_username,
                     image_url
                  )
                )
                conn.commit()
                cur.close()
                logger.info(f"New product added: {product_name} by {seller_username}")
                return True, "Product listed successfully."
        except psycopg2.IntegrityError as e:
            logger.warning(f"Integrity error adding product {product_name}: {e}")
            return False, "A product with this name already exists. Try a different name."
        except Exception as e:
            logger.error(f"Error adding product {product_name}: {e}")
            return False, "We couldn't add that product right now. Please try again."

    def sell_product(self, product_name, quantity, buyer_username):
        try:
            quantity = int(quantity)
            if quantity <= 0:
                return False, "Quantity must be greater than 0."

            with get_db_connection() as conn:
                cur = conn.cursor()

                cur.execute(
                    "SELECT id, quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);",
                    (product_name,)
                )
                row = cur.fetchone()

                if not row:
                    cur.close()
                    return False, "Product not found."

                product_id, current_qty, seller_username = row

                if seller_username == buyer_username:
                    cur.close()
                    logger.warning(f"Self-purchase attempt by {buyer_username} for {product_name}")
                    return False, "You cannot purchase your own product."

                if current_qty < quantity:
                    cur.close()
                    return False, f"Only {current_qty} left in stock - you asked for {quantity}."

                new_qty = current_qty - quantity
                cur.execute("UPDATE products SET quantity = %s WHERE id = %s;", (new_qty, product_id))
                conn.commit()
                cur.close()
                logger.info(f"Sale: {buyer_username} purchased {quantity} units of {product_name}")
                return True, f"Purchase successful! Bought {quantity} unit(s) of {product_name}."
        except ValueError:
            return False, "Invalid quantity."
        except Exception as e:
            logger.error(f"Error selling product {product_name}: {e}")
            return False, "We couldn't complete that purchase. Please try again."

    def restock_product(self, product_name, quantity, seller_username):
        try:
            quantity = int(quantity)
            if quantity <= 0:
                return False, "Quantity must be greater than 0."

            with get_db_connection() as conn:
                cur = conn.cursor()

                cur.execute(
                    "SELECT id, quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);",
                    (product_name,)
                )
                row = cur.fetchone()

                if not row:
                    cur.close()
                    return False, "Product not found."

                product_id, existing_qty, existing_seller = row

                if existing_seller != seller_username:
                    cur.close()
                    logger.warning(f"Unauthorized restock attempt by {seller_username} for {product_name}")
                    return False, "You do not own this product."

                new_qty = existing_qty + quantity
                cur.execute("UPDATE products SET quantity = %s WHERE id = %s;", (new_qty, product_id))
                conn.commit()
                cur.close()
                logger.info(f"Product {product_name} restocked by {seller_username}. New qty: {new_qty}")
                return True, f"Restocked {quantity} unit(s). New quantity: {new_qty}."
        except ValueError:
            return False, "Invalid quantity."
        except Exception as e:
            logger.error(f"Error restocking product {product_name}: {e}")
            return False, "We couldn't restock that item right now. Please try again."

    def edit_product(self, product_name, seller_username, new_price=None, new_category=None, new_quantity=None):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()

                cur.execute(
                    "SELECT id FROM products WHERE LOWER(product_name) = LOWER(%s) AND seller_username = %s;",
                    (product_name, seller_username)
                )
                row = cur.fetchone()

                if not row:
                    cur.close()
                    logger.warning(f"Edit attempt on non-existent or unauthorized product: {product_name}")
                    return False, "Product not found or you do not own it."

                product_id = row[0]

                updates = []
                params = []

                if new_price is not None:
                    try:
                        price_val = float(new_price)
                        if not math.isfinite(price_val) or price_val < 0:
                            return False, "Price must be a finite number greater than or equal to 0."
                        updates.append("price = %s")
                        params.append(price_val)
                    except (ValueError, TypeError):
                        return False, "Invalid price."

                if new_category is not None:
                    if new_category not in ALLOWED_PRODUCT_CATEGORIES:
                        return False, f"Invalid category. Allowed: {', '.join(ALLOWED_PRODUCT_CATEGORIES)}"
                    updates.append("category = %s")
                    params.append(new_category)

                if new_quantity is not None:
                    try:
                        qty_val = int(new_quantity)
                        if qty_val < 0:
                            return False, "Quantity cannot be negative."
                        updates.append("quantity = %s")
                        params.append(qty_val)
                    except (ValueError, TypeError):
                        return False, "Invalid quantity."

                if not updates:
                    cur.close()
                    return False, "No changes were specified."

                params.append(product_id)
                query = f"UPDATE products SET {', '.join(updates)} WHERE id = %s;"

                cur.execute(query, tuple(params))
                conn.commit()
                row_count = cur.rowcount
                cur.close()

                if row_count > 0:
                    logger.info(f"Product {product_name} edited by {seller_username}")
                    return True, "Product updated successfully."
                return False, "Update failed."
        except Exception as e:
            logger.error(f"Error editing product {product_name}: {e}")
            return False, "We couldn't update that product right now. Please try again."

    def delete_product(self, product_name, seller_username):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()

                cur.execute(
                    "SELECT id FROM products WHERE LOWER(product_name) = LOWER(%s) AND seller_username = %s;",
                    (product_name, seller_username)
                )
                row = cur.fetchone()

                if not row:
                    cur.close()
                    logger.warning(f"Delete attempt on non-existent or unauthorized product: {product_name}")
                    return False, "Product not found or you do not own it."

                product_id = row[0]

                cur.execute("DELETE FROM products WHERE id = %s;", (product_id,))
                conn.commit()
                row_count = cur.rowcount
                cur.close()

                if row_count > 0:
                    logger.info(f"Product {product_name} deleted by {seller_username}")
                    return True, "Product removed from your store."
                return False, "Deletion failed."
        except Exception as e:
            logger.error(f"Error deleting product {product_name}: {e}")
            return False, "We couldn't delete that product right now. Please try again."

    def get_statistics(self, seller_username=None):
        """Compute stats either across the whole marketplace, or - when
        seller_username is given - scoped to just that seller's own listings."""
        try:
            with get_db_connection() as conn:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                if seller_username:
                    cur.execute(
                        'SELECT product_name, price, category, quantity FROM products WHERE seller_username = %s ORDER BY price DESC;',
                        (seller_username,)
                    )
                else:
                    cur.execute('SELECT product_name, price, category, quantity FROM products ORDER BY price DESC;')
                products = cur.fetchall()
                cur.close()

                if not products:
                    return {"total_products": 0, "total_quantity": 0, "expensive": "N/A", "cheapest": "N/A", "avg_price": "$0.00"}

                total_products = len(products)
                total_quantity = sum(int(p["quantity"]) for p in products)
                expensive = max(products, key=lambda x: float(x["price"]))
                cheapest = min(products, key=lambda x: float(x["price"]))
                avg_price = sum(float(p["price"]) for p in products) / total_products

                return {
                    "total_products": total_products,
                    "total_quantity": total_quantity,
                    "expensive": f"{expensive['product_name']} (${float(expensive['price']):.2f})",
                    "cheapest": f"{cheapest['product_name']} (${float(cheapest['price']):.2f})",
                    "avg_price": f"${avg_price:.2f}"
                }
        except Exception as e:
            logger.error(f"Error retrieving statistics: {e}")
            return {"total_products": 0, "total_quantity": 0, "expensive": "Error", "cheapest": "Error", "avg_price": "$0.00"}


def get_product_owner(product_name):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()
            cur.close()
            return row[0] if row else None
    except Exception as e:
        logger.error(f"Error retrieving product owner for {product_name}: {e}")
        return None


def email_already_registered(email):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM users WHERE email = %s;", (email,))
            exists = cur.fetchone() is not None
            cur.close()
            return exists
    except Exception as e:
        logger.error(f"Error checking email uniqueness for {email}: {e}")
        return False


# --- ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/register', methods=['POST'])
@validate_json(RegisterSchema)
def register():
    username = request.validated_data['username'].strip()
    password = request.validated_data['password']
    email = request.validated_data['email'].strip()

    user = Useraccount(username)
    if not user.is_new:
        return api_error("That username is already taken.", 409)

    if email_already_registered(email):
        return api_error("That email is already registered. Try signing in instead.", 409)

    success, result = user.set_password(password, email)

    if not success:
        return api_error(result, 409)

    verification_token = result
    email_sent = send_verification_email(email, username, verification_token)

    if not email_sent:
        return api_error("Account created, but the verification email could not be sent. Please contact support.", 502)

    return api_ok("Account created. Check your email to verify your account before signing in.", 201)


# This route was missing entirely - the email links to it, but nothing
# handled the request, so verification could never actually complete.
@app.route('/verify-email/<token>')
def verify_email(token):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT username FROM users WHERE verification_token = %s;", (token,))
            row = cur.fetchone()

            if not row:
                cur.close()
                return _verification_page(
                    "Link not valid",
                    "This verification link is invalid or has already been used.",
                    ok=False
                ), 400

            username = row[0]
            cur.execute(
                "UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE username = %s;",
                (username,)
            )
            conn.commit()
            cur.close()

        logger.info(f"Email verified for user: {username}")
        return _verification_page(
            "Email verified",
            f"Thanks, {username} - your email is verified. You can close this tab and sign in."
        )
    except Exception as e:
        logger.error(f"Email verification failed for token {token}: {e}")
        return _verification_page(
            "Something went wrong",
            "We couldn't verify your email right now. Please try the link again shortly.",
            ok=False
        ), 500


@app.route('/api/resend-verification', methods=['POST'])
@validate_json(ResendVerificationSchema)
def resend_verification():
    username = request.validated_data['username'].strip()
    generic_message = "If that account exists and needs verifying, a new email is on its way."

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT email, email_verified FROM users WHERE username = %s;", (username,))
            row = cur.fetchone()

            if not row:
                cur.close()
                # Same generic message whether or not the account exists,
                # for the same enumeration-prevention reason as login.
                return api_ok(generic_message)

            email, email_verified = row
            if email_verified:
                cur.close()
                return api_ok("This account is already verified - you can sign in.")

            new_token = secrets.token_urlsafe(32)
            cur.execute("UPDATE users SET verification_token = %s WHERE username = %s;", (new_token, username))
            conn.commit()
            cur.close()

        email_sent = send_verification_email(email, username, new_token)
        if not email_sent:
            logger.error("Verification email resend failed for %s", username)
            return api_error("We couldn't send the verification email. Please try again shortly.", 502)
        return api_ok(generic_message)

    except Exception as e:
        logger.error(f"Resend verification failed for {username}: {e}")
        return api_error("We couldn't process that right now. Please try again shortly.", 500)


def _verification_page(title, message, ok=True):
    color = "#02c39a" if ok else "#ff5a5f"
    safe_title = escape(title)
    safe_message = escape(message)
    return f"""
    <html>
    <head><title>{safe_title} - Blue Mart</title></head>
    <body style="background:#0b1329; color:#ffffff; font-family:system-ui, sans-serif;
                 display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
        <div style="text-align:center; max-width:420px; padding:30px;">
            <h2 style="color:{color};">{safe_title}</h2>
            <p style="color:#9aa5b1;">{safe_message}</p>
            <a href="/" style="color:#5bc0be; text-decoration:none; font-weight:600;">Go to Blue Mart &rarr;</a>
        </div>
    </body>
    </html>
    """


@app.route('/api/login', methods=['POST'])
@validate_json(LoginSchema)
def login():
    username = request.validated_data['username'].strip()
    password = request.validated_data['password']

    try:
        user = Useraccount(username)
        success, msg = user.verify_password(password)
        if success:
            session.clear()
            session['username'] = user.username
            return api_ok(msg, 200, username=user.username)
        return api_error(msg, 401)
    except Exception as e:
        logger.error(f"Login error for {username}: {e}")
        return api_error("We couldn't sign you in right now. Please try again shortly.", 500)

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return api_ok("Logged out safely.")

@app.route('/api/session', methods=['GET'])
def check_session():
    if 'username' in session:
        return jsonify({"logged_in": True, "username": session['username']}), 200
    return jsonify({"logged_in": False}), 200

@app.route('/api/products', methods=['GET'])
def get_products():
    try:
        with get_db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                 """SELECT id,
                 product_name AS "Product Name",
                 price AS "Price",
                 category AS "Category",
                 quantity AS "Quantity",
                 seller_username AS "Seller",
                 image_url AS "image_url"
                 FROM products
                 ORDER BY product_name ASC;"""
                )
            rows = cur.fetchall()
            cur.close()
        return jsonify(rows), 200
    except Exception as e:
        logger.error(f"Error retrieving products: {e}")
        return api_error("We couldn't load the marketplace right now. Please refresh.", 503)

      

# -----------------------------------------------------------------------------
# CART API
# -----------------------------------------------------------------------------

@app.route('/api/cart/add', methods=['POST'])
@require_login
@validate_json(AddToCartSchema)
def add_to_cart():
    username = session['username']
    product_id = request.validated_data['product_id']
    quantity = request.validated_data['quantity']

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT product_name, quantity, seller_username
                FROM products
                WHERE id = %s
                FOR UPDATE;
            """, (product_id,))
            product = cur.fetchone()

            if not product:
                cur.close()
                return api_error("Product not found.", 404)

            product_name, stock, seller_username = product

            if seller_username == username:
                cur.close()
                return api_error("You cannot add your own product to your cart.", 400)

            if stock <= 0:
                cur.close()
                return api_error("This product is out of stock.", 400)

            cur.execute("""
                SELECT quantity
                FROM cart_items
                WHERE username = %s AND product_id = %s;
            """, (username, product_id))
            existing = cur.fetchone()

            new_quantity = quantity + (existing[0] if existing else 0)
            if new_quantity > stock:
                cur.close()
                return api_error(f"Only {stock} item(s) are available.", 400)

            if existing:
                cur.execute("""
                    UPDATE cart_items
                    SET quantity = %s
                    WHERE username = %s AND product_id = %s;
                """, (new_quantity, username, product_id))
                message = f"{product_name} quantity updated in your cart."
            else:
                cur.execute("""
                    INSERT INTO cart_items (username, product_id, quantity)
                    VALUES (%s, %s, %s);
                """, (username, product_id, quantity))
                message = f"{product_name} added to your cart."

            conn.commit()
            cur.close()
        return api_ok(message)
    except Exception as e:
        logger.exception("Add to cart failed: %s", e)
        return api_error("We couldn't add that product to your cart.", 500)


@app.route('/api/cart', methods=['GET'])
@require_login
def get_cart():
    username = session['username']
    try:
        with get_db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT c.id, c.product_id, p.product_name, p.price, c.quantity,
                       p.image_url, p.quantity AS available_stock,
                       (p.price * c.quantity) AS subtotal
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.username = %s
                ORDER BY c.id DESC;
            """, (username,))
            rows = cur.fetchall()
            cur.close()

        items = []
        for row in rows:
            items.append({
                "id": row["id"],
                "product_id": row["product_id"],
                "product_name": row["product_name"],
                "price": float(row["price"]),
                "quantity": int(row["quantity"]),
                "image_url": row["image_url"],
                "available_stock": int(row["available_stock"]),
                "subtotal": float(row["subtotal"])
            })

        total = round(sum(item["subtotal"] for item in items), 2)
        return api_ok("Cart loaded.", items=items, total=total)
    except Exception as e:
        logger.exception("Get cart failed: %s", e)
        return api_error("We couldn't load your cart.", 500)


@app.route('/api/cart/update', methods=['PUT'])
@require_login
@validate_json(UpdateCartSchema)
def update_cart():
    username = session['username']
    product_id = request.validated_data['product_id']
    quantity = request.validated_data['quantity']

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT quantity FROM products WHERE id = %s FOR UPDATE;", (product_id,))
            product = cur.fetchone()
            if not product:
                cur.close()
                return api_error("Product not found.", 404)

            stock = product[0]
            if quantity > stock:
                cur.close()
                return api_error(f"Only {stock} item(s) are available.", 400)

            cur.execute("""
                UPDATE cart_items
                SET quantity = %s
                WHERE username = %s AND product_id = %s;
            """, (quantity, username, product_id))
            if cur.rowcount == 0:
                cur.close()
                return api_error("Product is not in your cart.", 404)

            conn.commit()
            cur.close()
        return api_ok("Cart updated successfully.")
    except Exception as e:
        logger.exception("Update cart failed: %s", e)
        return api_error("We couldn't update your cart.", 500)


@app.route('/api/cart/remove/<int:product_id>', methods=['DELETE'])
@require_login
def remove_from_cart(product_id):
    username = session['username']
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                DELETE FROM cart_items
                WHERE username = %s AND product_id = %s;
            """, (username, product_id))
            if cur.rowcount == 0:
                cur.close()
                return api_error("Product is not in your cart.", 404)
            conn.commit()
            cur.close()
        return api_ok("Product removed from cart.")
    except Exception as e:
        logger.exception("Remove cart item failed: %s", e)
        return api_error("We couldn't remove that product.", 500)


@app.route('/api/cart/clear', methods=['DELETE'])
@require_login
def clear_cart():
    username = session['username']
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM cart_items WHERE username = %s;", (username,))
            conn.commit()
            cur.close()
        return api_ok("Cart cleared.")
    except Exception as e:
        logger.exception("Clear cart failed: %s", e)
        return api_error("We couldn't clear your cart.", 500)


# -----------------------------------------------------------------------------
# ORDER + PAYMENT API
# -----------------------------------------------------------------------------

@app.route('/api/orders/create', methods=['POST'])
@require_login
def create_order():
    """Create an unpaid order from the current cart. Stock is not reduced yet."""
    username = session['username']

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT c.product_id, c.quantity, p.product_name, p.price,
                       p.quantity AS stock, p.seller_username
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.username = %s
                FOR UPDATE OF p;
            """, (username,))
            items = cur.fetchall()

            if not items:
                cur.close()
                return api_error("Your cart is empty.", 400)

            total = Decimal('0.00')
            for product_id, qty, name, price, stock, seller in items:
                if seller == username:
                    conn.rollback()
                    cur.close()
                    return api_error(f"You cannot purchase your own product: {name}.", 400)
                if qty > stock:
                    conn.rollback()
                    cur.close()
                    return api_error(f"Not enough stock for {name}. Only {stock} available.", 400)
                total += price * qty

            cur.execute("""
                INSERT INTO orders (username, total_amount, status, payment_status)
                VALUES (%s, %s, 'pending', 'unpaid')
                RETURNING id;
            """, (username, total))
            order_id = cur.fetchone()[0]

            for product_id, qty, name, price, stock, seller in items:
                cur.execute("""
                    INSERT INTO order_items
                        (order_id, product_id, product_name, price, quantity)
                    VALUES (%s, %s, %s, %s, %s);
                """, (order_id, product_id, name, price, qty))

            conn.commit()
            cur.close()

        return api_ok("Order created.", order_id=order_id, total=float(total))
    except Exception as e:
        logger.exception("Create order failed: %s", e)
        return api_error("We couldn't create your order.", 500)


@app.route('/api/orders', methods=['GET'])
@require_login
def get_orders():
    username = session['username']
    try:
        with get_db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT id, total_amount, status, payment_status, created_at
                FROM orders
                WHERE username = %s
                ORDER BY created_at DESC;
            """, (username,))
            rows = cur.fetchall()
            cur.close()

        orders = [{
            "id": row["id"],
            "total": float(row["total_amount"]),
            "status": row["status"],
            "payment_status": row["payment_status"],
            "created_at": row["created_at"].isoformat()
        } for row in rows]
        return api_ok("Orders loaded.", orders=orders)
    except Exception as e:
        logger.exception("Get orders failed: %s", e)
        return api_error("We couldn't load your orders.", 500)


@app.route('/api/orders/<int:order_id>', methods=['GET'])
@require_login
def get_order(order_id):
    username = session['username']
    try:
        with get_db_connection() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT id, total_amount, status, payment_status, created_at
                FROM orders
                WHERE id = %s AND username = %s;
            """, (order_id, username))
            order = cur.fetchone()
            if not order:
                cur.close()
                return api_error("Order not found.", 404)

            cur.execute("""
                SELECT product_id, product_name, price, quantity,
                       price * quantity AS subtotal
                FROM order_items
                WHERE order_id = %s
                ORDER BY id;
            """, (order_id,))
            items = cur.fetchall()
            cur.close()

        return api_ok(
            "Order loaded.",
            order={
                "id": order["id"],
                "total": float(order["total_amount"]),
                "status": order["status"],
                "payment_status": order["payment_status"],
                "created_at": order["created_at"].isoformat(),
                "items": [{
                    "product_id": item["product_id"],
                    "product_name": item["product_name"],
                    "price": float(item["price"]),
                    "quantity": item["quantity"],
                    "subtotal": float(item["subtotal"])
                } for item in items]
            }
        )
    except Exception as e:
        logger.exception("Get order failed: %s", e)
        return api_error("We couldn't load that order.", 500)


@app.route('/api/create-checkout-session', methods=['POST'])
@require_login
def create_checkout_session():
    """Create a Stripe Checkout session from a fresh server-side cart snapshot."""
    username = session['username']

    if not STRIPE_SECRET_KEY:
        return api_error("Payment system is not configured yet.", 503)
    if not BASE_URL:
        return api_error("BASE_URL is not configured yet.", 503)

    try:
        # Build a fresh unpaid order first. This gives Stripe a stable order id.
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT c.product_id, c.quantity, p.product_name, p.price,
                       p.quantity AS stock, p.seller_username
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.username = %s
                FOR UPDATE OF p;
            """, (username,))
            items = cur.fetchall()

            if not items:
                cur.close()
                return api_error("Your cart is empty.", 400)

            total = Decimal('0.00')
            for product_id, qty, name, price, stock, seller in items:
                if seller == username:
                    conn.rollback()
                    cur.close()
                    return api_error(f"You cannot purchase your own product: {name}.", 400)
                if qty > stock:
                    conn.rollback()
                    cur.close()
                    return api_error(f"Not enough stock for {name}. Only {stock} available.", 400)
                total += price * qty

            cur.execute("""
                INSERT INTO orders (username, total_amount, status, payment_status)
                VALUES (%s, %s, 'pending', 'unpaid')
                RETURNING id;
            """, (username, total))
            order_id = cur.fetchone()[0]

            for product_id, qty, name, price, stock, seller in items:
                cur.execute("""
                    INSERT INTO order_items
                        (order_id, product_id, product_name, price, quantity)
                    VALUES (%s, %s, %s, %s, %s);
                """, (order_id, product_id, name, price, qty))

            conn.commit()
            cur.close()

        line_items = []
        for product_id, qty, name, price, stock, seller in items:
            unit_amount = int((Decimal(str(price)) * 100).quantize(Decimal('1')))
            line_items.append({
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": name},
                    "unit_amount": unit_amount
                },
                "quantity": qty
            })

        checkout = stripe.checkout.Session.create(
            mode='payment',
            line_items=line_items,
            success_url=f"{BASE_URL}/?payment=success&order_id={order_id}",
            cancel_url=f"{BASE_URL}/?payment=cancelled&order_id={order_id}",
            metadata={
                "order_id": str(order_id),
                "username": username
            }
        )

        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("UPDATE orders SET stripe_session_id = %s WHERE id = %s;", (checkout.id, order_id))
            conn.commit()
            cur.close()

        return api_ok(
            "Checkout session created.",
            order_id=order_id,
            checkout_url=checkout.url
        )

    except Exception as e:
        logger.exception("Stripe checkout creation failed: %s", e)
        return api_error("We couldn't start the payment process.", 502)


@app.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    """Trust Stripe's signed webhook, then atomically finalize the order."""
    if not STRIPE_WEBHOOK_SECRET:
        logger.error("STRIPE_WEBHOOK_SECRET is missing.")
        return '', 500

    payload = request.get_data()
    signature = request.headers.get('Stripe-Signature', '')

    try:
        event = stripe.Webhook.construct_event(
            payload, signature, STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        return '', 400
    except stripe.error.SignatureVerificationError:
        return '', 400

    if event.get('type') != 'checkout.session.completed':
        return '', 200

    checkout = event['data']['object']
    payment_status = checkout.get('payment_status')
    if payment_status != 'paid':
        return '', 200

    metadata = checkout.get('metadata') or {}
    order_id = metadata.get('order_id')
    username = metadata.get('username')
    stripe_session_id = checkout.get('id')

    if not order_id or not username or not stripe_session_id:
        logger.error("Stripe webhook missing order metadata.")
        return '', 400

    try:
        email = None
        order_total = Decimal('0.00')

        with get_db_connection() as conn:
            cur = conn.cursor()

            # Lock the order. If another webhook delivery is processed at the
            # same time, only one can finalize it.
            cur.execute("""
                SELECT username, total_amount, payment_status
                FROM orders
                WHERE id = %s
                FOR UPDATE;
            """, (int(order_id),))
            order = cur.fetchone()

            if not order:
                cur.close()
                return '', 404

            order_username, order_total, current_payment_status = order

            if order_username != username:
                conn.rollback()
                cur.close()
                return '', 403

            # Idempotency: Stripe may deliver the same webhook more than once.
            if current_payment_status == 'paid':
                cur.close()
                return '', 200

            cur.execute("SELECT email FROM users WHERE username = %s;", (username,))
            user_row = cur.fetchone()
            email = user_row[0] if user_row else None

            cur.execute("""
                SELECT oi.product_id, oi.quantity, oi.product_name, oi.price,
                       p.quantity AS stock, p.seller_username
                FROM order_items oi
                JOIN products p ON p.id = oi.product_id
                WHERE oi.order_id = %s
                FOR UPDATE OF p;
            """, (int(order_id),))
            items = cur.fetchall()

            if not items:
                conn.rollback()
                cur.close()
                return '', 409

            calculated_total = Decimal('0.00')
            for product_id, qty, name, price, stock, seller in items:
                if seller == username:
                    conn.rollback()
                    cur.close()
                    return '', 409
                if stock < qty:
                    logger.error(
                        "Insufficient stock while finalizing paid order %s: %s",
                        order_id, name
                    )
                    conn.rollback()
                    cur.close()
                    return '', 409
                calculated_total += price * qty

            # Make sure the amount stored by our server still matches the item snapshot.
            if calculated_total != order_total:
                logger.error(
                    "Order total mismatch for order %s: stored=%s calculated=%s",
                    order_id, order_total, calculated_total
                )
                conn.rollback()
                cur.close()
                return '', 409

            # Reduce stock only after Stripe confirms payment.
            for product_id, qty, name, price, stock, seller in items:
                cur.execute("""
                    UPDATE products
                    SET quantity = quantity - %s
                    WHERE id = %s AND quantity >= %s;
                """, (qty, product_id, qty))
                if cur.rowcount != 1:
                    conn.rollback()
                    cur.close()
                    return '', 409

            cur.execute("""
                UPDATE orders
                SET status = 'processing',
                    payment_status = 'paid',
                    stripe_session_id = %s
                WHERE id = %s;
            """, (stripe_session_id, int(order_id)))

            # Only clear the cart rows that still match the purchased quantities.
            # The order is based on the cart snapshot, so a customer can add a new
            # quantity while paying without having unrelated new rows deleted.
            for product_id, qty, name, price, stock, seller in items:
                cur.execute("""
                    DELETE FROM cart_items
                    WHERE username = %s AND product_id = %s
                      AND quantity = %s;
                """, (username, product_id, qty))

            conn.commit()
            cur.close()

        if email:
            send_order_confirmation_email(
                email, username, int(order_id), float(order_total)
            )

        logger.info("Stripe payment completed for order #%s", order_id)
        return '', 200

    except Exception as e:
        logger.exception("Stripe webhook processing failed: %s", e)
        return '', 500


# -----------------------------------------------------------------------------
# NEWSLETTER / OPT-IN
# -----------------------------------------------------------------------------

@app.route('/api/newsletter/subscribe', methods=['POST'])
@validate_json(NewsletterSchema)
def newsletter_subscribe():
    email = request.validated_data['email'].strip().lower()

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO newsletter_subscribers (email)
                VALUES (%s)
                ON CONFLICT (email) DO NOTHING;
            """, (email,))
            inserted = cur.rowcount
            conn.commit()
            cur.close()

        if inserted:
            return api_ok("Thanks for subscribing to BlueMart!")
        return api_ok("You're already subscribed.")
    except Exception as e:
        logger.exception("Newsletter subscription failed: %s", e)
        return api_error("We couldn't subscribe you right now.", 500)


@app.route('/api/products/add', methods=['POST'])
@require_login
def add_product():
    try:
        name = request.form.get('name', '').strip()
        price = request.form.get('price')
        category = request.form.get('category', '').strip()
        quantity = request.form.get('quantity')

        image = request.files.get('image')

        if not name:
            return api_error("Product name is required.", 400)

        if not price or not category or not quantity:
            return api_error("Price, category, and quantity are all required.", 400)

        if category not in ALLOWED_PRODUCT_CATEGORIES:
            return api_error(f"Invalid category. Allowed: {', '.join(ALLOWED_PRODUCT_CATEGORIES)}", 400)

        try:
            price_val = float(price)
            quantity_val = int(quantity)
        except (TypeError, ValueError):
            return api_error("Price and quantity must be valid numbers.", 400)

        if not math.isfinite(price_val) or price_val < 0:
            return api_error("Price must be a finite number greater than or equal to 0.", 400)
        if quantity_val < 0:
            return api_error("Quantity cannot be negative.", 400)

        if len(name) > MAX_PRODUCT_NAME_LENGTH:
            return api_error(f"Product name must be at most {MAX_PRODUCT_NAME_LENGTH} characters.", 422)

        image_url = None
        if image and image.filename:
            allowed_image_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
            if image.mimetype not in allowed_image_types:
                return api_error("Unsupported image type. Use JPEG, PNG, WEBP, or GIF.", 415)
            try:
                upload_result = cloudinary.uploader.upload(image, folder="bluemart/products", resource_type="image")
                image_url = upload_result.get("secure_url")
            except Exception as e:
                logger.error(f"Image upload failed: {e}")
                return api_error("We couldn't upload that image. Try a different file or list without one.", 502)

        pm = ProductManager()
        success, msg = pm.add_product(name, price_val, category, quantity_val, session['username'], image_url)
        status_code = 201 if success else 400
        return jsonify({"success": success, "message": msg, "image_url": image_url}), status_code

    except Exception as e:
        logger.error(f"Error adding product: {e}")
        return api_error("We couldn't add that product right now. Please try again.", 500)

@app.route('/api/products/delete', methods=['POST'])
@require_login
@validate_json(DeleteProductSchema)
def delete_product():
    name = request.validated_data['name'].strip()
    owner = get_product_owner(name)

    if owner is None:
        return api_error("Product not found.", 404)
    if owner != session['username']:
        return api_error("You can only delete your own products.", 403)

    pm = ProductManager()
    success, msg = pm.delete_product(name, session['username'])
    return jsonify({"success": success, "message": msg}), (200 if success else 400)

@app.route('/api/products/sell', methods=['POST'])
@require_login
@validate_json(SellProductSchema)
def sell_product():
    name = request.validated_data['name'].strip()
    quantity = request.validated_data['quantity']

    pm = ProductManager()
    success, msg = pm.sell_product(name, quantity, session['username'])
    return jsonify({"success": success, "message": msg}), (200 if success else 400)

@app.route('/api/products/restock', methods=['POST'])
@require_login
@validate_json(RestockProductSchema)
def restock_product():
    name = request.validated_data['name'].strip()
    quantity = request.validated_data['quantity']
    owner = get_product_owner(name)

    if owner is None:
        return api_error("Product not found.", 404)
    if owner != session['username']:
        return api_error("You can only restock your own products.", 403)

    pm = ProductManager()
    success, msg = pm.restock_product(name, quantity, session['username'])
    return jsonify({"success": success, "message": msg}), (200 if success else 400)

@app.route('/api/products/edit', methods=['POST'])
@require_login
@validate_json(EditProductSchema)
def edit_product():
    name = request.validated_data['name'].strip()
    owner = get_product_owner(name)

    if owner is None:
        return api_error("Product not found.", 404)
    if owner != session['username']:
        return api_error("You can only edit your own products.", 403)

    pm = ProductManager()
    success, msg = pm.edit_product(
        name,
        session['username'],
        new_price=request.validated_data.get('price'),
        new_category=request.validated_data.get('category'),
        new_quantity=request.validated_data.get('quantity')
    )
    return jsonify({"success": success, "message": msg}), (200 if success else 400)

@app.route('/api/statistics', methods=['GET'])
def get_stats():
    """Marketplace-wide statistics (kept for potential future admin use)."""
    pm = ProductManager()
    return jsonify(pm.get_statistics()), 200

@app.route('/api/statistics/mine', methods=['GET'])
@require_login
def get_my_stats():
    """Statistics scoped to the signed-in seller's own listings only."""
    pm = ProductManager()
    return jsonify(pm.get_statistics(seller_username=session['username'])), 200

@app.errorhandler(400)
def bad_request(error):
    return api_error("Bad request.", 400)

@app.errorhandler(403)
def forbidden(error):
    return api_error("You don't have permission to do that.", 403)

@app.errorhandler(404)
def not_found(error):
    return api_error("That endpoint doesn't exist.", 404)

@app.errorhandler(405)
def method_not_allowed(error):
    return api_error("That method isn't allowed on this endpoint.", 405)

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return api_error("Something went wrong on our end. Please try again.", 500)


try:
    init_db()
except Exception as e:
    logger.error(f"Failed to initialize database on startup: {e}")

if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_ENV') == 'development'
    app.run(debug=debug_mode, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
