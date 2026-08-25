import os
from flask import Flask, render_template, request, jsonify, session
import psycopg2
from psycopg2.extras import RealDictCursor

app = Flask(__name__, template_folder='.')
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "super-secret-fallback-key-change-in-render")

# --- DATABASE CONFIGURATION ---
DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

def get_db_connection():
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL environment variable is missing on Render configuration.")
    return psycopg2.connect(DATABASE_URL)

def init_db():
    # Every account can now both buy and sell, so there is no "role" column
    # anymore - permissions are based purely on who owns a given product.
    if not DATABASE_URL:
        print("DATABASE_URL is missing.")
        return

    try:
        conn = get_db_connection()
        cur = conn.cursor()

        print("DATABASE BOOT: Checking database structure...")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username VARCHAR(100) PRIMARY KEY,
                password VARCHAR(255) NOT NULL
            );
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                product_name VARCHAR(255) UNIQUE NOT NULL,
                price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
                category VARCHAR(100),
                quantity INT NOT NULL DEFAULT 0,
                seller_username VARCHAR(100)
            );
        """)

        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'products_seller_username_fkey'
                ) THEN
                    ALTER TABLE products
                    ADD CONSTRAINT products_seller_username_fkey
                    FOREIGN KEY (seller_username)
                    REFERENCES users(username)
                    ON DELETE SET NULL;
                END IF;
            END
            $$;
        """)

        conn.commit()
        cur.close()
        conn.close()

        print("DATABASE BOOT: Database structure is ready!")

    except Exception as e:
        print("Database initialization failed:", e)


# --- BACKEND BUSINESS LOGIC ---
class Useraccount:
    def __init__(self, user_name):
        self.user_name = user_name
        self.password = None
        self.is_new = True

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT password FROM users WHERE username = %s;", (self.user_name,))
            row = cur.fetchone()
            if row:
                self.password = row[0]
                self.is_new = False
            cur.close()
            conn.close()
        except Exception as e:
            print("Error retrieving user profile account data:", e)

    def set_password(self, password_input):
        if not self.is_new:
            return False, "User already exists."
        if len(password_input) < 6:
            return False, "Password must be at least 6 characters."

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO users (username, password) VALUES (%s, %s);",
                (self.user_name, password_input)
            )
            conn.commit()
            cur.close()
            conn.close()
            self.password = password_input
            self.is_new = False
            return True, "Account created successfully."
        except Exception as e:
            return False, f"Account profile writing failed: {str(e)}"

    def verify_password(self, password_input):
        if self.password is None:
            return False, "No password set. Register first."
        if password_input == self.password:
            return True, "Password verified successfully."
        return False, "Incorrect password."


class ProductManager:
    def add_product(self, product_name, price, category, quantity, seller_username):
        try:
            conn = get_db_connection()
            cur = conn.cursor()

            cur.execute(
                "SELECT quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);",
                (product_name,)
            )
            row = cur.fetchone()

            if row:
                existing_qty, existing_seller = row
                if existing_seller != seller_username:
                    cur.close()
                    conn.close()
                    return "A product with this name is already listed by another seller. Try a different name."

                new_qty = existing_qty + int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return f"You already listed this product. Increased quantity to {new_qty}."

            cur.execute(
                "INSERT INTO products (product_name, price, category, quantity, seller_username) VALUES (%s, %s, %s, %s, %s);",
                (product_name, float(price), category, int(quantity), seller_username)
            )
            conn.commit()
            cur.close()
            conn.close()
            return "Product listed successfully."
        except Exception as e:
            return f"Error executing asset registration database entry: {str(e)}"

    def sell_product(self, product_name, quantity, buyer_username):
        try:
            conn = get_db_connection()
            cur = conn.cursor()

            # Fetch current quantity AND owner profile details
            cur.execute("SELECT quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()

            if not row:
                cur.close()
                conn.close()
                return False, "Product not found."

            current_qty = row[0]
            seller_username = row[1]

            # BLOCK OWNERSHIP SALE: Prevent the seller from buying their own product
            if seller_username == buyer_username:
                cur.close()
                conn.close()
                return False, "Transaction blocked: You cannot purchase your own listed item!"

            if current_qty >= int(quantity):
                new_qty = current_qty - int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return True, f"Sold {quantity} units of {product_name}."

            cur.close()
            conn.close()
            return False, "Insufficient quantity available."
        except Exception as e:
            return False, f"Transaction calculation trace failed: {str(e)}"

    def restock_product(self, product_name, quantity, seller_username):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            
            cur.execute("SELECT quantity, seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()

            if row:
                existing_qty, existing_seller = row
                
                # Check ownership authority
                if existing_seller != seller_username:
                    cur.close()
                    conn.close()
                    return False, "Permission denied: You do not own this product listing."

                new_qty = existing_qty + int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return True, f"Restocked {quantity} units of {product_name}."

            cur.close()
            conn.close()
            return False, "Product not found."
        except Exception as e:
            return False, f"Stock trace update writing task failed: {str(e)}"

    def edit_product(self, product_name, seller_username, new_price=None, new_category=None, new_quantity=None):
        try:
            conn = get_db_connection()
            cur = conn.cursor()

            # First verify that this user actually owns the product they are editing
            cur.execute("SELECT seller_username FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()

            if not row:
                cur.close()
                conn.close()
                return False, "Product not found."

            if row[0] != seller_username:
                cur.close()
                conn.close()
                return False, "Permission denied: You cannot edit another seller's product."

            # Construct dynamic UPDATE query updates block safely
            updates = []
            params = []

            if new_price is not None and new_price != '':
                updates.append("price = %s")
                params.append(float(new_price))
            if new_category is not None and new_category != '':
                updates.append("category = %s")
                params.append(new_category)
            if new_quantity is not None and new_quantity != '':
                updates.append("quantity = %s")
                params.append(int(new_quantity))

            if not updates:
                cur.close()
                conn.close()
                return True, "No changes specified."

           
            params.append(product_name)
            query = f"UPDATE products SET {', '.join(updates)} WHERE LOWER(product_name) = LOWER(%s);"
            
            cur.execute(query, tuple(params))
            conn.commit()
            cur.close()
            conn.close()
            return True, "Product updated successfully."
        except Exception as e:
            return False, f"Product update failed: {str(e)}"
