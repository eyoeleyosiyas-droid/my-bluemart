import os
from flask import Flask, render_template, request, jsonify
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
    if not DATABASE_URL:
        return
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        print("DATABASE BOOT: Executing a clean manual wipe and rebuild...")
        
        # 1. DROP old tables to clear any structural glitches completely
        cur.execute("DROP TABLE IF EXISTS products CASCADE;")
        cur.execute("DROP TABLE IF EXISTS users CASCADE;")
        conn.commit()
        
        # 2. CREATE the brand new users table with the role column built-in
        cur.execute("""
            CREATE TABLE users (
                username VARCHAR(100) PRIMARY KEY,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'buyer'
            );
        """)
        conn.commit()
        
        # 3. CREATE the brand new products table with multi-vendor support built-in
        cur.execute("""
            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                product_name VARCHAR(255) UNIQUE NOT NULL,
                price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
                category VARCHAR(100),
                quantity INT NOT NULL DEFAULT 0,
                seller_username VARCHAR(100) REFERENCES users(username) ON DELETE SET NULL
            );
        """)
        conn.commit()
        
        cur.close()
        conn.close()
        print("DATABASE BOOT: All database tables recreated perfectly!")
    except Exception as e:
        print("Database fresh reset sequence failed:", e)




# --- BACKEND BUSINESS LOGIC ---
class Useraccount:
    def __init__(self, user_name):
        self.user_name = user_name
        self.password = None
        self.role = 'buyer'  # Default fallback
        self.is_new = True
        
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            # Fetch both password AND role from database
            cur.execute("SELECT password, role FROM users WHERE username = %s;", (self.user_name,))
            row = cur.fetchone()
            if row:
                self.password = row[0]  # FIX: Extract individual string index 0
                self.role = row[1]      # FIX: Extract individual string index 1
                self.is_new = False
            cur.close()
            conn.close()
        except Exception as e:
            print("Error retrieving user profile account data:", e)

    def set_password(self, password_input, role_input='buyer'):
        if not self.is_new:
            return False, "User already exists."
        if len(password_input) < 6:
            return False, "Password must be at least 6 characters."
        if role_input not in ['buyer', 'seller']:
            role_input = 'buyer'
        
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            # Save the chosen role during registration
            cur.execute(
                "INSERT INTO users (username, password, role) VALUES (%s, %s, %s);", 
                (self.user_name, password_input, role_input)
            )
            conn.commit()
            cur.close()
            conn.close()
            self.password = password_input
            self.role = role_input
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
from flask import session

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/register', methods=['POST'])
def register():
    req = request.json
    username = req.get('username')
    password = req.get('password')
    role = req.get('role', 'buyer')  # Expects frontend to pass 'buyer' or 'seller'
    
    user = Useraccount(username)
    success, msg = user.set_password(password, role)
    return jsonify({"success": success, "message": msg})

@app.route('/api/login', methods=['POST'])
def login():
    req = request.json
    username = req.get('username')
    password = req.get('password')
    
    user = Useraccount(username)
    success, msg = user.verify_password(password)
    
    if success:
        # Save user tracking information into cookie session memory
        session['username'] = user.user_name
        session['role'] = user.role
        return jsonify({"success": True, "message": msg, "role": user.role, "username": user.user_name})
        
    return jsonify({"success": False, "message": msg})

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"success": True, "message": "Logged out safely."})

@app.route('/api/products', methods=['GET'])
def get_products():
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        # Fetching inventory so buyers can view everything
        cur.execute("SELECT product_name AS \"Product Name\", price AS \"Price\", category AS \"Category\", quantity AS \"Quantity\", seller_username AS \"Seller\" FROM products;")
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return jsonify(rows)
    except Exception as e:
        return jsonify([])

@app.route('/api/products/add', methods=['POST'])
def add_product():
    # SECURITY GUARD: Deny access if not logged in as a seller
    if 'username' not in session or session.get('role') != 'seller':
        return jsonify({"success": False, "message": "Unauthorized. Only verified store sellers can add stock."}), 403
        
    req = request.json
    p = ProductManager()
    
    # Modify query logic to associate item with the active session user
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO products (product_name, price, category, quantity, seller_username) VALUES (%s, %s, %s, %s, %s);",
            (req['name'], float(req['price']), req['category'], int(req['quantity']), session['username'])
        )
        conn.commit()
        cur.close()
        conn.close()
        msg = "Product listed successfully under your vendor profile."
    except Exception as e:
        msg = f"Failed to list item: {str(e)}"
        
    return jsonify({"success": True, "message": msg})

@app.route('/api/products/delete', methods=['POST'])
def delete_product():
    # SECURITY GUARD: Block non-sellers from executing deletions
    if 'username' not in session or session.get('role') != 'seller':
        return jsonify({"success": False, "message": "Access Denied."}), 403
        
    req = request.json
    p = ProductManager()
    
    # Cross-verify that the seller trying to delete the item actually owns it
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT seller_username FROM products WHERE TRIM(LOWER(product_name)) = TRIM(LOWER(%s));", (req['name'],))
        row = cur.fetchone()
        
        if not row:
            return jsonify({"success": False, "message": "Product not found."})
            
        if row[0] != session['username']:
            return jsonify({"success": False, "message": "Unauthorized. You do not own this store item layout."}), 401
            
        success, msg = p.delete_product(req['name'])
        return jsonify({"success": success, "message": msg})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

# --- REST OF BUYER ORDER ACTIONS ---
@app.route('/api/products/sell', methods=['POST'])
def sell_product():
    # Buyers triggering an order call this route to simulate purchasing stock 
    req = request.json
    p = ProductManager()
    success, msg = p.sell_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/restock', methods=['POST'])
def restock_product():
    if 'username' not in session or session.get('role') != 'seller':
        return jsonify({"success": False, "message": "Unauthorized."}), 403
    req = request.json
    p = ProductManager()
    success, msg = p.restock_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/edit', methods=['POST'])
def edit_product():
    if 'username' not in session or session.get('role') != 'seller':
        return jsonify({"success": False, "message": "Unauthorized."}), 403
    req = request.json
    p = ProductManager()
    success, msg = p.edit_product(req['name'], req.get('price'), req.get('category'), req.get('quantity'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/statistics', methods=['GET'])
def get_stats():
    p = ProductManager()
    return jsonify(p.get_statistics())
@app.route('/force-database-update-xyz')
def force_update():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Force inject the missing column manually
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'buyer';")
        cur.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_username VARCHAR(100) REFERENCES users(username) ON DELETE SET NULL;")
        
        conn.commit()
        cur.close()
        conn.close()
        return "Database architecture updated successfully! Go back and try registering now."
    except Exception as e:
        return f"Database update failed: {str(e)}"

if __name__ == '__main__':
    app.run(debug=True)

