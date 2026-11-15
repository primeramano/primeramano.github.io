# Reglas permanentes — Tienda Primera Mano

Ver `PLAN.md` en esta misma carpeta para el plan completo (contexto, decisiones, flujos de trabajo, formato de producto, lecciones de errores pasados). Estas son las reglas que siempre aplican:

1. Escribirle a Santi en español rioplatense, directo, con recomendación concreta y sin palabras técnicas. Si hay que usar una, explicarla en una frase.
2. No gastar de más: hacer el trabajo de datos uno mismo en vez de pedirle cosas a Santi. Reportar corto.
3. La tienda vive en GitHub Pages. **No usar Netlify ni nada que cobre o tenga límites de pago.** Si algo nuevo cuesta plata, avisar antes.
4. Fuente de verdad del catálogo: `data/products.json` del repositorio.
5. **Precio de venta = costo del proveedor × 1,35, redondeado al múltiplo de $100 más cercano.** Fórmula exacta: `price = int(round(costo*1.35/100))*100`.
6. Ningún producto puede quedar con precio menor a esa fórmula. Excepción: cuando Santi da un precio exacto, se respeta y se avisa en el reporte.
7. Siempre trabajar con el proveedor **en vivo**. Nunca usar archivos guardados de días anteriores: eso ya produjo falsos "no encontrado" y falsos "sin stock".
8. Stock en el proveedor: el campo confiable es `type`. `"available"` = en stock. `"unavailable"` = sin stock.
9. Stock en la tienda: sin stock = `"stock": false`. En stock = el campo no existe.
10. Nunca escribir "Revoleos" ni "Pency" en ningún texto visible de la tienda.
11. Nunca poner precios dentro de la descripción.
12. Títulos limpios: sin "- Cod …", sin códigos, sin precios.
13. Antes de agregar un producto, buscarlo por ID **y** por nombre (con sinónimos) para no duplicarlo.
14. Productos sin stock no se borran: se marcan.
15. Las fotos son las del proveedor, tal cual (img = primera foto, imgHi = la misma o mejor, images = todas).
16. Cada cambio se prueba primero en versión de prueba. Se publica sólo cuando Santi aprueba.
17. Después de cada trabajo, reportar: qué se tocó, cuántos productos, qué quedó sin resolver.
18. Nunca escribir contraseñas, claves ni tokens en archivos del repositorio.
