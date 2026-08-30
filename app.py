import secrets
import cloudinary
import cloudinary.uploader
import os
import logging
from contextlib import contextmanager
from functools import wraps

from flask import Flask, render_template, request, jsonify, session
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

app = Flask(__name__, template_folder='.')
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "super-secret-fallback-key-change-in-render")

MIN_PASSWORD_LENGTH = 6
MAX_USERNAME_LENGTH = 100
MAX_PRODUCT_NAME_LENGTH = 255
ALLOWED_PRODUCT_CATEGORIES = [
    "Electronics", "Clothing", "Food", "Books", "Furniture", "Other"
]

DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

db_pool = None

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
        init_connection_pool()

        with get_db_connection() as conn:
            cur = conn.cursor()

            logger.info("DATABASE BOOT: Checking database structure...")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    username VARCHAR(100) PRIMARY KEY,
                    password_hash VARCHAR(255) NOT NULL
                );
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

            # Covers the case where the table already existed from a deploy
            # before image_url was added - CREATE TABLE IF NOT EXISTS alone
            # won't add a column to an existing table.
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

            conn.commit()
            cur.close()

            logger.info("DATABASE BOOT: Database structure is ready!")

    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        raise


class RegisterSchema(Schema):
    username = fields.Str(required=True, validate=validate.Length(min=1, max=MAX_USERNAME_LENGTH))
    password = fields.Str(required=True, validate=validate.Length(min=MIN_PASSWORD_LENGTH))

class LoginSchema(Schema):
    username = fields.Str(required=True)
    password = fields.Str(required=True)

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


def validate_json(schema_class):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            try:
                data = request.get_json()
                if not data:
                    return jsonify({"success": False, "message": "Invalid or missing JSON."}), 400
                schema = schema_class()
                validated_data = schema.load(data)
                request.validated_data = validated_data
            except ValidationError as err:
                logger.warning(f"Validation error in {f.__name__}: {err.messages}")
                return jsonify({"success": False, "message": "Validation error.", "errors": err.messages}), 422
            except Exception as e:
                logger.error(f"Error in validate_json: {e}")
                return jsonify({"success": False, "message": "Request processing error."}), 400
            return f(*args, **kwargs)
        return decorated_function
    return decorator

def require_login(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            return jsonify({"success": False, "message": "Please sign in."}), 403
        return f(*args, **kwargs)
    return decorated_function


class Useraccount:
    def __init__(self, username):
        self.username = username
        self.password_hash = None
        self.is_new = True

        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                cur.execute("SELECT password_hash FROM users WHERE username = %s;", (self.username,))
                row = cur.fetchone()
                if row:
                    self.password_hash = row[0]
                    self.is_new = False
                cur.close()
        except Exception as e:
            logger.error(f"Error retrieving user {self.username}: {e}")
            raise

    def set_password(self, password_input):
        if not self.is_new:
            return False, "User already exists."
        if len(password_input) < MIN_PASSWORD_LENGTH:
            return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters."

        try:
    password_hash = generate_password_hash(
        password_input,
        method='pbkdf2:sha256'
    )

    verification_token = secrets.token_urlsafe(32)

    with get_db_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            """INSERT INTO users
               (username, password_hash, email, email_verified, verification_token)
               VALUES (%s, %s, %s, %s, %s);""",
            (
                self.username,
                password_hash,
                email,
                False,
                verification_token
            )
        )

        conn.commit()
        cur.close()

    self.password_hash = password_hash
    self.is_new = False

    logger.info(f"Account created for user: {self.username}")

    return True, "Account created successfully."

except psycopg2.IntegrityError:
    logger.warning(f"Duplicate username attempt: {self.username}")
    return False, "Username already taken."

except Exception as e:
    logger.error(f"Error creating account for {self.username}: {e}")
    return False, "Account creation failed."
    def verify_password(self, password_input):
        if self.password_hash is None:
            return False, "User does not exist. Register first."
        if check_password_hash(self.password_hash, password_input):
            logger.info(f"User {self.username} logged in successfully.")
            return True, "Password verified successfully."
        logger.warning(f"Failed login attempt for user: {self.username}")
        return False, "Incorrect password."


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
            return False, "Product listing error. This name may already exist."
        except Exception as e:
            logger.error(f"Error adding product {product_name}: {e}")
            return False, "Failed to add product."

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
                    return False, f"Insufficient quantity. Available: {current_qty}, Requested: {quantity}"

                new_qty = current_qty - quantity
                cur.execute("UPDATE products SET quantity = %s WHERE id = %s;", (new_qty, product_id))
                conn.commit()
                cur.close()
                logger.info(f"Sale: {buyer_username} purchased {quantity} units of {product_name}")
                return True, f"Purchase successful! Bought {quantity} units of {product_name}."
        except ValueError:
            return False, "Invalid quantity."
        except Exception as e:
            logger.error(f"Error selling product {product_name}: {e}")
            return False, "Purchase failed."

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
                return True, f"Restocked {quantity} units. New quantity: {new_qty}."
        except ValueError:
            return False, "Invalid quantity."
        except Exception as e:
            logger.error(f"Error restocking product {product_name}: {e}")
            return False, "Restock failed."

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
                        if price_val < 0:
                            return False, "Price cannot be negative."
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
                    return False, "No modifications specified."

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
            return False, "Product update failed."

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
                    return True, f"Product deleted successfully."
                return False, "Deletion failed."
        except Exception as e:
            logger.error(f"Error deleting product {product_name}: {e}")
            return False, "Product deletion failed."

    def get_statistics(self):
        try:
            with get_db_connection() as conn:
                cur = conn.cursor(cursor_factory=RealDictCursor)
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


@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/register', methods=['POST'])
@validate_json(RegisterSchema)
def register():
    username = request.validated_data['username'].strip()
    password = request.validated_data['password']

    user = Useraccount(username)
    success, msg = user.set_password(password)
    status_code = 201 if success else 400
    return jsonify({"success": success, "message": msg}), status_code

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
            return jsonify({"success": True, "message": msg, "username": user.username}), 200
        return jsonify({"success": False, "message": msg}), 401
    except Exception as e:
        logger.error(f"Login error for {username}: {e}")
        return jsonify({"success": False, "message": "Login failed."}), 500

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"success": True, "message": "Logged out safely."}), 200

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
                 """SELECT product_name AS "Product Name",
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
        return jsonify({"success": False, "message": "Failed to retrieve products."}), 500


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
            return jsonify({"success": False, "message": "Product Name is required."}), 400

        if not price or not category or not quantity:
            return jsonify({
                "success": False,
                "message": "Price, category, and quantity are all required."
            }), 400

        if category not in ALLOWED_PRODUCT_CATEGORIES:
            return jsonify({
                "success": False,
                "message": f"Invalid category. Allowed: {', '.join(ALLOWED_PRODUCT_CATEGORIES)}"
            }), 400

        image_url = None

        if image:
            upload_result = cloudinary.uploader.upload(
                image,
                folder="bluemart/products"
            )
            image_url = upload_result.get("secure_url")

        pm = ProductManager()

        success, msg = pm.add_product(
            name,
            float(price),
            category,
            int(quantity),
            session['username'],
            image_url
        )

        status_code = 201 if success else 400

        return jsonify({
            "success": success,
            "message": msg,
            "image_url": image_url
        }), status_code

    except Exception as e:
        logger.error(f"Error adding product: {e}")
        return jsonify({
           "success": False,
           "message": "Failed to add product."
        }), 500

@app.route('/api/products/delete', methods=['POST'])
@require_login
@validate_json(DeleteProductSchema)
def delete_product():
    name = request.validated_data['name'].strip()
    owner = get_product_owner(name)

    if owner is None:
        return jsonify({"success": False, "message": "Product not found."}), 404
    if owner != session['username']:
        return jsonify({"success": False, "message": "You can only delete your own products."}), 403

    pm = ProductManager()
    success, msg = pm.delete_product(name, session['username'])
    status_code = 200 if success else 400
    return jsonify({"success": success, "message": msg}), status_code

@app.route('/api/products/sell', methods=['POST'])
@require_login
@validate_json(SellProductSchema)
def sell_product():
    name = request.validated_data['name'].strip()
    quantity = request.validated_data['quantity']

    pm = ProductManager()
    success, msg = pm.sell_product(name, quantity, session['username'])
    status_code = 200 if success else 400
    return jsonify({"success": success, "message": msg}), status_code

@app.route('/api/products/restock', methods=['POST'])
@require_login
@validate_json(RestockProductSchema)
def restock_product():
    name = request.validated_data['name'].strip()
    quantity = request.validated_data['quantity']
    owner = get_product_owner(name)

    if owner is None:
        return jsonify({"success": False, "message": "Product not found."}), 404
    if owner != session['username']:
        return jsonify({"success": False, "message": "You can only restock your own products."}), 403

    pm = ProductManager()
    success, msg = pm.restock_product(name, quantity, session['username'])
    status_code = 200 if success else 400
    return jsonify({"success": success, "message": msg}), status_code

@app.route('/api/products/edit', methods=['POST'])
@require_login
@validate_json(EditProductSchema)
def edit_product():
    name = request.validated_data['name'].strip()
    owner = get_product_owner(name)

    if owner is None:
        return jsonify({"success": False, "message": "Product not found."}), 404
    if owner != session['username']:
        return jsonify({"success": False, "message": "You can only edit your own products."}), 403

    pm = ProductManager()
    success, msg = pm.edit_product(
        name,
        session['username'],
        new_price=request.validated_data.get('price'),
        new_category=request.validated_data.get('category'),
        new_quantity=request.validated_data.get('quantity')
    )
    status_code = 200 if success else 400
    return jsonify({"success": success, "message": msg}), status_code

@app.route('/api/statistics', methods=['GET'])
def get_stats():
    pm = ProductManager()
    return jsonify(pm.get_statistics()), 200

@app.errorhandler(404)
def not_found(error):
    return jsonify({"success": False, "message": "Endpoint not found."}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify({"success": False, "message": "Internal server error."}), 500


try:
    init_connection_pool()
    init_db()
except Exception as e:
    logger.error(f"Failed to initialize database on startup: {e}")

if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_ENV') == 'development'
    app.run(debug=debug_mode, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
