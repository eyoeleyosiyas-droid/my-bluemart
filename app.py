import os
from flask import Flask, render_template, request, jsonify
import psycopg2
from psycopg2.extras import RealDictCursor

app = Flask(__name__, template_folder='.')

# --- DATABASE CONFIGURATION ---
DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

def get_db_connection():
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL environment variable is missing on Render configuration.")
    return psycopg2.connect(DATABASE_URL)

def init_db():
    if not DATABASE_URL:
        return
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
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
                quantity INT NOT NULL DEFAULT 0
            );
        """)
        
        conn.commit()
        cur.close()
        conn.close()
        print("Database schemas checked and built successfully.")
    except Exception as e:
        print("Database migration error on startup:", e)

init_db()

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
            cur.execute("INSERT INTO users (username, password) VALUES (%s, %s);", (self.user_name, password_input))
            conn.commit()
            cur.close()
            conn.close()
            self.password = password_input
            self.is_new = False
            return True, "Password set successfully."
        except Exception as e:
            return False, f"Account profile writing failed: {str(e)}"

    def verify_password(self, password_input):
        if self.password is None:
            return False, "No password set. Register first."
        if password_input == self.password:
            return True, "Password verified successfully."
        return False, "Incorrect password."


class ProductManager:
    def add_product(self, product_name, price, category, quantity):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            
            cur.execute("SELECT quantity FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()
            
            if row:
                new_qty = row[0] + int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return f"Product existed. Increased quantity to {new_qty}."
            
            cur.execute(
                "INSERT INTO products (product_name, price, category, quantity) VALUES (%s, %s, %s, %s);",
                (product_name, float(price), category, int(quantity))
            )
            conn.commit()
            cur.close()
            conn.close()
            return "Product added successfully."
        except Exception as e:
            return f"Error executing asset registration database entry: {str(e)}"

    def sell_product(self, product_name, quantity):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT quantity FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()
            
            if not row:
                return False, "Product not found."
            
            current_qty = row[0]
            if current_qty >= int(quantity):
                new_qty = current_qty - int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return True, f"Sold {quantity} units of {product_name}."
            
            return False, "Insufficient quantity available."
        except Exception as e:
            return False, f"Transaction calculation trace failed: {str(e)}"

    def restock_product(self, product_name, quantity):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT quantity FROM products WHERE LOWER(product_name) = LOWER(%s);", (product_name,))
            row = cur.fetchone()
            
            if row:
                new_qty = row[0] + int(quantity)
                cur.execute("UPDATE products SET quantity = %s WHERE LOWER(product_name) = LOWER(%s);", (new_qty, product_name))
                conn.commit()
                cur.close()
                conn.close()
                return True, f"Restocked {quantity} units of {product_name}."
            
            return False, "Product not found."
        except Exception as e:
            return False, f"Stock trace update writing task failed: {str(e)}"

    def edit_product(self, product_name, new_price=None, new_category=None, new_quantity=None):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            
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
                return False, "No modifications specified."
                
            query = f"UPDATE products SET {', '.join(updates)} WHERE LOWER(product_name) = LOWER(%s);"
            params.append(product_name)
            
            cur.execute(query, tuple(params))
            conn.commit()
            row_count = cur.rowcount
            cur.close()
            conn.close()
            
            if row_count > 0:
                return True, "Product updated successfully."
            return False, "Product not found."
        except Exception as e:
            return False, f"Target update validation execution error: {str(e)}"

    def delete_product(self, product_name):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
        
            # Use TRIM() to strip hidden spaces from both the database column AND the input
            query = "DELETE FROM products WHERE TRIM(LOWER(product_name)) = TRIM(LOWER(%s));"
        
            # Clean up the input string variable just in case
            cleaned_name = product_name.strip()
        
            cur.execute(query, (cleaned_name,))
            conn.commit()
            row_count = cur.rowcount
            cur.close()
            conn.close()
        
            if row_count > 0:
               return True, f"Product {product_name} deleted."
               return False, "Product not found."
            except Exception as e:
               return False, f"Target purge row compilation sequence dropped: {str(e)}"


    def get_statistics(self):
        try:
            conn = get_db_connection()
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT product_name AS \"Product Name\", price AS \"Price\", category AS \"Category\", quantity AS \"Quantity\" FROM products;")
            products = cur.fetchall()
            cur.close()
            conn.close()
            
            if not products:
                return {"total_products": 0, "total_quantity": 0, "expensive": "N/A", "cheapest": "N/A", "avg_price": "$0.00"}
                
            total_products = len(products)
            total_quantity = sum(p["Quantity"] for p in products)
            expensive = max(products, key=lambda x: float(x["Price"]))
            cheapest = min(products, key=lambda x: float(x["Price"]))
            avg_price = sum(float(p["Price"]) for p in products) / total_products
            
            return {
                "total_products": total_products,
                "total_quantity": total_quantity,
                "expensive": f"{expensive['Product Name']} (${float(expensive['Price']):.2f})",
                "cheapest": f"{cheapest['Product Name']} (${float(cheapest['Price']):.2f})",
                "avg_price": f"${avg_price:.2f}"
            }
        except Exception as e:
            print("System Metrics generation failed:", e)
            return {"total_products": 0, "total_quantity": 0, "expensive": "Error", "cheapest": "Error", "avg_price": "$0.00"}


# --- ROUTING ENDPOINTS ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/register', methods=['POST'])
def register():
    req = request.json
    user = Useraccount(req.get('username'))
    success, msg = user.set_password(req.get('password'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/login', methods=['POST'])
def login():
    req = request.json
    user = Useraccount(req.get('username'))
    success, msg = user.verify_password(req.get('password'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/products', methods=['GET'])
def get_products():
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT product_name AS \"Product Name\", price AS \"Price\", category AS \"Category\", quantity AS \"Quantity\" FROM products;")
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return jsonify(rows)
    except Exception as e:
        return jsonify([])

@app.route('/api/products/add', methods=['POST'])
def add_product():
    req = request.json
    p = ProductManager()
    msg = p.add_product(req['name'], req['price'], req['category'], req['quantity'])
    return jsonify({"success": True, "message": msg})

@app.route('/api/products/sell', methods=['POST'])
def sell_product():
    req = request.json
    p = ProductManager()
    success, msg = p.sell_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/restock', methods=['POST'])
def restock_product():
    req = request.json
    p = ProductManager()
    success, msg = p.restock_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/edit', methods=['POST'])
def edit_product():
    req = request.json
    p = ProductManager()
    success, msg = p.edit_product(req['name'], req.get('price'), req.get('category'), req.get('quantity'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/delete', methods=['POST'])
def delete_product():
    req = request.json
    p = ProductManager()
    success, msg = p.delete_product(req['name'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/statistics', methods=['GET'])
def get_stats():
    p = ProductManager()
    return jsonify(p.get_statistics())

if __name__ == '__main__':
    app.run(debug=True)
