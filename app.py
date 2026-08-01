import json
import os
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

DATA_FILE = "blue_mart_data.json"

def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as file:
            try:
                return json.load(file)
            except json.JSONDecodeError:
                return {"users": {}, "products": []}
    return {"users": {}, "products": []}

def save_data(data):
    with open(DATA_FILE, "w") as file:
        json.dump(data, file, indent=4)

class Useraccount:
    def __init__(self, user_name, system_data):
        self.user_name = user_name
        self.system_data = system_data
        if self.user_name in self.system_data["users"]:
            self.password = self.system_data["users"][self.user_name]
            self.is_new = False
        else:
            self.password = None
            self.is_new = True

    def set_password(self, password_input):
        if not self.is_new:
            return False, "User already exists."
        if len(password_input) >= 6:
            self.password = password_input
            self.system_data["users"][self.user_name] = self.password
            save_data(self.system_data)
            return True, "Password set successfully."
        return False, "Password must be at least 6 characters."

    def verify_password(self, password_input):
        if self.password is None:
            return False, "No password set. Register first."
        if password_input == self.password:
            return True, "Password verified successfully."
        return False, "Incorrect password."

class Product:
    def __init__(self, system_data):
        self.system_data = system_data
        self.product_info = self.system_data["products"]

    def add_product(self, product_name, price, category, quantity):
        for info in self.product_info:
            if info["Product Name"].lower() == product_name.lower():
                info["Quantity"] += int(quantity)
                save_data(self.system_data)
                return f"Product existed. Increased quantity to {info['Quantity']}."
        new_product = {
            "Product Name": product_name,
            "Price": float(price),
            "Category": category,
            "Quantity": int(quantity),
        }
        self.product_info.append(new_product)
        save_data(self.system_data)
        return "Product added successfully."

    def sell_product(self, product_name, quantity):
        for info in self.product_info:
            if info["Product Name"].lower() == product_name.lower():
                if info["Quantity"] >= int(quantity):
                    info["Quantity"] -= int(quantity)
                    save_data(self.system_data)
                    return True, f"Sold {quantity} units of {product_name}."
                return False, "Insufficient quantity available."
        return False, "Product not found."

    def restock_product(self, product_name, quantity):
        for info in self.product_info:
            if info["Product Name"].lower() == product_name.lower():
                info["Quantity"] += int(quantity)
                save_data(self.system_data)
                return True, f"Restocked {quantity} units of {product_name}."
        return False, "Product not found."

    def edit_product(self, product_name, new_price=None, new_category=None, new_quantity=None):
        for info in self.product_info:
            if info["Product Name"].lower() == product_name.lower():
                if new_price: info["Price"] = float(new_price)
                if new_category: info["Category"] = new_category
                if new_quantity: info["Quantity"] = int(new_quantity)
                save_data(self.system_data)
                return True, "Product updated successfully."
        return False, "Product not found."

    def delete_product(self, product_name):
        for info in self.product_info:
            if info["Product Name"].lower() == product_name.lower():
                self.product_info.remove(info)
                save_data(self.system_data)
                return True, f"Product {product_name} deleted."
        return False, "Product not found."

    def get_statistics(self):
        if not self.product_info:
            return {"total_products": 0, "total_quantity": 0, "expensive": "N/A", "cheapest": "N/A", "avg_price": 0}
        total_products = len(self.product_info)
        total_quantity = sum(info["Quantity"] for info in self.product_info)
        expensive = max(self.product_info, key=lambda x: x["Price"])
        cheapest = min(self.product_info, key=lambda x: x["Price"])
        avg_price = sum(info["Price"] for info in self.product_info) / total_products
        return {
            "total_products": total_products,
            "total_quantity": total_quantity,
            "expensive": f"{expensive['Product Name']} (${expensive['Price']:.2f})",
            "cheapest": f"{cheapest['Product Name']} (${cheapest['Price']:.2f})",
            "avg_price": f"${avg_price:.2f}"
        }

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/register', methods=['POST'])
def register():
    data = load_data()
    req = request.json
    user = Useraccount(req.get('username'), data)
    success, msg = user.set_password(req.get('password'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/login', methods=['POST'])
def login():
    data = load_data()
    req = request.json
    user = Useraccount(req.get('username'), data)
    success, msg = user.verify_password(req.get('password'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/products', methods=['GET'])
def get_products():
    data = load_data()
    return jsonify(data["products"])

@app.route('/api/products/add', methods=['POST'])
def add_product():
    data = load_data()
    req = request.json
    p = Product(data)
    msg = p.add_product(req['name'], req['price'], req['category'], req['quantity'])
    return jsonify({"success": True, "message": msg})

@app.route('/api/products/sell', methods=['POST'])
def sell_product():
    data = load_data()
    req = request.json
    p = Product(data)
    success, msg = p.sell_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/restock', methods=['POST'])
def restock_product():
    data = load_data()
    req = request.json
    p = Product(data)
    success, msg = p.restock_product(req['name'], req['quantity'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/edit', methods=['POST'])
def edit_product():
    data = load_data()
    req = request.json
    p = Product(data)
    success, msg = p.edit_product(req['name'], req.get('price'), req.get('category'), req.get('quantity'))
    return jsonify({"success": success, "message": msg})

@app.route('/api/products/delete', methods=['POST'])
def delete_product():
    data = load_data()
    req = request.json
    p = Product(data)
    success, msg = p.delete_product(req['name'])
    return jsonify({"success": success, "message": msg})

@app.route('/api/statistics', methods=['GET'])
def get_stats():
    data = load_data()
    p = Product(data)
    return jsonify(p.get_statistics())

if __name__ == '__main__':
    app.run(debug=True)
