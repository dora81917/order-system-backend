-- 建立 menu_items 資料表
CREATE TABLE IF NOT EXISTS menu_items (
    id SERIAL PRIMARY KEY,
    name JSONB NOT NULL,
    price INTEGER NOT NULL,
    image VARCHAR(255),
    description JSONB,
    category VARCHAR(50) NOT NULL,
    options TEXT
);

-- 建立 orders 資料表
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    table_number VARCHAR(50) NOT NULL,
    total_amount INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'received',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 建立 order_items 資料表
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    menu_item_id INTEGER REFERENCES menu_items(id),
    quantity INTEGER NOT NULL,
    notes TEXT
);

-- 清空舊資料以避免重複插入
TRUNCATE TABLE menu_items RESTART IDENTITY CASCADE;

-- 插入菜單資料
INSERT INTO menu_items (name, price, image, description, category, options) VALUES
('{"zh": "招牌牛肉麵", "en": "Signature Beef Noodle Soup", "ja": "特製牛肉麺", "ko": "시그니처 소고기 국수"}', 180, 'https://placehold.co/600x400/EAD9C8/513C2C?text=牛肉麵', '{"zh": "慢火燉煮的牛骨高湯，搭配軟嫩牛腱肉與Q彈麵條。", "en": "Slow-cooked beef broth with tender beef shank and chewy noodles."}', 'main', 'spice,size'),
('{"zh": "香煎雞腿排飯", "en": "Pan-Fried Chicken Steak Rice", "ja": "鶏もも肉のソテーライス", "ko": "치킨 스테이크 라이스"}', 220, 'https://placehold.co/600x400/D8C2A8/4D4030?text=雞腿排', '{"zh": "外皮酥脆、肉質多汁的雞腿排，附三樣配菜。", "en": "Crispy skin and juicy chicken steak, served with three side dishes."}', 'main', 'size'),
('{"zh": "黃金炸豆腐", "en": "Golden Fried Tofu", "ja": "揚げ出し豆腐", "ko": "황금 튀김 두부"}', 60, 'https://placehold.co/600x400/F0E4D4/8A6D3B?text=炸豆腐', '{"zh": "外酥內嫩，搭配特調蒜蓉醬油。", "en": "Crispy on the outside, soft on the inside, with special garlic soy sauce."}', 'side', 'spice'),
('{"zh": "珍珠奶茶", "en": "Bubble Milk Tea", "ja": "タピオカミルクティー", "ko": "버블 밀크티"}', 70, 'https://placehold.co/600x400/C8B4A4/3E2E1E?text=珍奶', '{"zh": "經典台灣味，香濃奶茶與Q彈珍珠的完美結合。", "en": "Classic Taiwanese flavor, a perfect blend of rich milk tea and chewy bubbles."}', 'drink', 'sugar,ice'),
('{"zh": "法式烤布蕾", "en": "Crème brûlée", "ja": "クレームブリュレ", "ko": "크렘 브륄레"}', 90, 'https://placehold.co/600x400/F5D5A4/8C5A2B?text=烤布蕾', '{"zh": "香草卡士達與焦脆糖衣的絕妙搭配。", "en": "A delightful combination of vanilla custard and a crispy caramelized sugar top."}', 'dessert', '');
