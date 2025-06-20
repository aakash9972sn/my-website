// Sample Node.js backend endpoints:

// 1. User Authentication
POST /api/auth/login
POST /api/auth/register
POST /api/auth/forgot-password

// 2. Product Management
GET /api/products
POST /api/products
PUT /api/products/:id
DELETE /api/products/:id

// 3. Order Processing
POST /api/orders
GET /api/orders/:userId

// 4. Payment Integration
POST /api/payment/create-order
POST /api/payment/verify
