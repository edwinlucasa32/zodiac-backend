const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// ==================================================
// CONEXIÓN A POSTGRESQL (PARA RAILWAY)
// ==================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================================================
// CONFIGURACIÓN DE GROQ (ASISTENTE IA)
// ==================================================
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// ==================================================
// REGISTRO DE USUARIO
// ==================================================
app.post('/api/registro', async (req, res) => {
    const { nombre, apellido, tipo_cedula, cedula, email, password, telefono } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO usuarios (nombre, apellido, tipo_cedula, cedula, email, password, telefono) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING user_id`,
            [nombre, apellido, tipo_cedula, cedula, email, password, telefono]
        );
        res.json({ success: true, userId: result.rows[0].user_id });
    } catch (error) {
        console.error(error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================================================
// LOGIN DE USUARIO
// ==================================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            `SELECT user_id, nombre, apellido, email FROM usuarios WHERE email = $1 AND password = $2`,
            [email, password]
        );
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, error: "Email o contraseña incorrectos" });
        }
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================================================
// GUARDAR COMPRA (PAGO MÓVIL O TRANSFERENCIA)
// ==================================================
app.post('/api/compras', async (req, res) => {
    const { user_id, total, metodo, direccion_envio, productos_comprados } = req.body;
    
    console.log("📦 Recibida compra:", { user_id, total, metodo, direccion_envio });
    
    try {
        await pool.query('BEGIN');
        
        const compraResult = await pool.query(
            `INSERT INTO compras (user_id, total, metodo_pago, direccion_envio, estado) 
             VALUES ($1, $2, $3, $4, 'pendiente_verificacion') RETURNING compra_id`,
            [user_id, total, metodo, direccion_envio]
        );
        
        const compraId = compraResult.rows[0].compra_id;
        console.log(`✅ Compra creada con ID: ${compraId}`);
        
        for (const item of productos_comprados) {
            await pool.query(
                `INSERT INTO detalle_compras (compra_id, producto_nombre, producto_signo, cantidad, precio_unitario) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [compraId, item.nombre, item.signo, item.cantidad, item.precio]
            );
        }
        
        await pool.query('COMMIT');
        res.json({ success: true, compraId: compraId });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("❌ Error al guardar compra:", error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================================================
// GUARDAR PAGO PENDIENTE (PAGO MÓVIL / TRANSFERENCIA)
// ==================================================
app.post('/api/pagos-pendientes', async (req, res) => {
    const { compra_id, user_id, referencia, banco_origen, telefono_cliente, estado } = req.body;
    
    console.log("📝 Registrando pago pendiente:", { compra_id, user_id, referencia, banco_origen, telefono_cliente });
    
    try {
        const result = await pool.query(
            `INSERT INTO pagos_pendientes (compra_id, user_id, referencia, banco_origen, telefono_cliente, estado) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [compra_id, user_id, referencia, banco_origen, telefono_cliente, estado || 'pendiente']
        );
        
        console.log(`✅ Pago pendiente registrado con ID: ${result.rows[0].id}`);
        res.json({ success: true, id: result.rows[0].id });
        
    } catch (error) {
        console.error("❌ Error al guardar pago pendiente:", error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================================================
// OBTENER COMPRAS DE UN USUARIO
// ==================================================
app.get('/api/compras/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT c.*, d.producto_nombre, d.producto_signo, d.cantidad, d.precio_unitario 
             FROM compras c
             JOIN detalle_compras d ON c.compra_id = d.compra_id
             WHERE c.user_id = $1
             ORDER BY c.fecha_compra DESC`,
            [userId]
        );
        res.json({ success: true, compras: result.rows });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================================================
// CHAT CON GROQ (ASISTENTE DE IA)
// ==================================================
app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'No se proporcionó ningún mensaje.' });
    }
    
    try {
        // Construir el historial de la conversación
        const messages = [
            {
                role: 'system',
                content: `Eres un asistente virtual amigable y servicial para "ZODIAC WEAR", una tienda de ropa con temática zodiacal.
Tu objetivo es ayudar a los clientes con información sobre productos (Suéteres y Camisas de los 12 signos),
guiarlos en el proceso de compra (agregar al carrito, pagar) y resolver sus dudas generales.
Hablas de manera clara, concisa y siempre en el contexto de la tienda.`
            },
            ...(history || []),
            { role: 'user', content: message }
        ];
        
        const chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: 'llama-3.1-8b-instant',
            temperature: 0.7,
            max_tokens: 1024,
        });
        
        const aiResponse = chatCompletion.choices[0]?.message?.content || 'Lo siento, no pude procesar tu solicitud.';
        
        res.json({ response: aiResponse });
        
    } catch (error) {
        console.error('Error al comunicarse con Groq:', error);
        res.status(500).json({ error: 'Error interno del servidor de chat.' });
    }
});

// ==================================================
// INICIAR SERVIDOR
// ==================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en el puerto: ${PORT}`);
    console.log(`📋 Endpoints:`);
    console.log(`   POST /api/registro`);
    console.log(`   POST /api/login`);
    console.log(`   POST /api/compras`);
    console.log(`   POST /api/pagos-pendientes`);
    console.log(`   GET  /api/compras/:userId`);
    console.log(`   POST /api/chat (🤖 Asistente IA)`);
});