# PLAN COMPLETO: Tienda Primera Mano

Documento para Claude Code. Tiene todo lo que hicimos hasta hoy, cómo lo hicimos, los errores que ya pasaron (para no repetirlos), las decisiones tomadas y las mejoras pedidas. Objetivo: que Claude Code trabaje sin hacerle preguntas a Santi.

Cómo usarlo: copiá la PARTE A en un archivo `CLAUDE.md` en la raíz del repositorio. Dejá este documento completo en el repositorio como `PLAN.md`.

---

## PARTE 0: Direcciones y datos fijos

| Qué | Dónde |
|---|---|
| Tienda en vivo | https://primeramano.github.io/ |
| Repositorio | `primeramano/primeramano.github.io`, rama `main` (público, necesario para GitHub Pages) |
| Proveedor (catálogo) | https://pency.app/revoleoficial |
| Pagos (función de Mercado Pago) | https://mp-checkout-puce.vercel.app (rutas: create-preference y webhook) |
| Archivos del repo | `index.html`, `app.js`, `styles.css`, `data/products.json`, `firebase-config.js`, `firestore.rules`, `README` |
| Base de datos | Firebase (Firestore): colecciones `carts` y `orders`. Login con Google |
| Panel de administración | La tienda con `?admin=1` al final de la dirección (se guarda en el navegador con la clave `pm_admin_mode_v1`) |
| Dueño | Santi. Idioma: español rioplatense, voseo |

Tarea programada existente: chequeo semanal de stock (id `trig_01EcAC8DkGsFvNvfV6kGaRt7`). Depende de que la computadora de Santi esté vinculada. Si Claude Code toma el flujo, revisar si conviene reemplazarla.

---

## PARTE A: Reglas permanentes (copiar a CLAUDE.md)

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

---

## PARTE B: Decisiones ya tomadas (no volver a preguntar)

| Tema | Decisión |
|---|---|
| Hosting de la tienda | GitHub Pages. Sin Netlify |
| Base de datos | Firebase, plan gratuito (no cobra solo: si llega al límite, frena) |
| Pagos | Mercado Pago Checkout Pro a través de la función en Vercel. Ya funciona, no se mueve sin que Santi lo pida |
| Envío a domicilio | $9.000 (Andreani) |
| Retiro en sucursal Andreani más cercana | $7.900 (el cliente indica la sucursal en el checkout) |
| Otras entregas | $0 |
| Formas de pago | Las que ya existen en el checkout. No cambiarlas sin pedido |
| Margen | ×1,35 siempre |
| Quién administra | Santi con su cuenta de Google |
| Cómo se prueba | Versión de prueba, revisa Santi desde el celular, aprueba y recién ahí se publica |
| README (migración a Firebase) | **Descartada.** Ignorarla |

Preocupación abierta (no resolver sola): el plan gratuito de Vercel es para uso personal y una tienda comercial podría quedar fuera de sus condiciones. Si Santi lo pide, proponer una alternativa gratuita para la función de pagos (por ejemplo Cloudflare Workers) con pasos y riesgos. No migrar sin aprobación.

---

## PARTE C: Panel de administración (lo que tiene que quedar listo)

Entrada: agregar `?admin=1` a la dirección e iniciar sesión con Google. Tiene que funcionar **igual de bien en celular que en computadora**. Santi lo va a usar sobre todo en celular.

### C1. Ya existe (verificar y no romper)
- Pestañas: Pedidos, Carritos abandonados, Panel de ventas, Productos.
- Cambio de estado de pedidos.
- Editor de productos con subida de fotos.
- Filtro de productos por categoría.
- Los pedidos guardan la entrega y, si es sucursal, el campo `sucursal`. La línea "Sucursal:" aparece en el mensaje de WhatsApp del pedido.

### C2. Completar el editor de productos (todo esto es obligatorio)
1. **Stock de un toque:** botón "Sin stock / En stock" sin abrir el editor completo.
2. **Precio:** campo editable + botón "Aplicar ×1,35" que calcula desde el costo guardado.
3. **Costo del proveedor:** campo interno `costo` (no se muestra al público).
4. **Categoría:** lista desplegable con las 15 categorías de la Parte D, nunca texto libre.
5. **Buscador:** por nombre; filtros por "sin stock", "en stock" y categoría.
6. **Fotos:** subir varias, ordenarlas arrastrando, elegir la principal, borrar una.
7. **Descripción:** campo con vista previa y una plantilla del formato de la Parte H.
8. **Duplicar:** copia lista para editar.
9. **Eliminar:** con confirmación ("¿Seguro? No se puede deshacer").
10. **ID del proveedor:** visible sólo para el administrador, para chequear stock.
11. **Alerta de margen:** marcar en rojo los productos con precio menor a costo × 1,35.
12. **Guardado claro:** mensaje "Guardado" o el motivo del error en palabras normales.

### C3. Completar pedidos
1. Buscar por nombre o teléfono.
2. Detalle completo: productos, cantidades, pago, entrega, dirección o sucursal.
3. Botón para escribirle al cliente por WhatsApp.
4. Estados: nuevo, en proceso, entregado, cancelado.
5. Total del día y de la semana visible arriba.

### C4. Requisitos de celular
- Botones de al menos 44 px de alto.
- Sin scroll horizontal en ninguna pantalla.
- Las pestañas del panel se ven completas.
- Si algo tarda más de 3 segundos, mostrar "Cargando…".

### C5. Mejoras extra a proponer (después de terminar C2 a C4, con aprobación)
- Edición de varios productos a la vez (marcar varios y cambiar categoría o stock).
- Botón "Revisar con el proveedor" que muestre diferencias de precio y stock.
- Botón de exportar el catálogo a planilla.
- Mejoras de velocidad (cargar imágenes más livianas) sin cambiar el diseño.

---

## PARTE D: Categorías (usar exactamente estos nombres)

Aire Libre y Jardín · Baño y Limpieza · Belleza y Bienestar · Cocina y Bazar · Comercial · Electrodomésticos · Herramientas y Baterías · Hogar y Decoración · Iluminación · Infantil y Juguetería · Mascotas · Moda y Valijas · Ofertas · Organización · Tecnología y Audio

Equivalencias orientativas del proveedor (para mapear nuevos):
- Artículos de Cocina, Bazar → Cocina y Bazar
- Juguetería / Infantil → Infantil y Juguetería
- Mobiliario / Colchones → Hogar y Decoración
- Ventilación, Electro chico → Electrodomésticos
- Limpieza → Baño y Limpieza
- Aire libre / Jardín / Camping → Aire Libre y Jardín
- Bienestar, Belleza → Belleza y Bienestar
- Cargadores, Audio, Tecnología → Tecnología y Audio

Si no encaja: dejar en "Organización" y avisar. **No crear categorías nuevas** sin permiso de Santi.

Pedido típico de Santi: "sumame los de X en la categoría Y". En ese caso la categoría la manda él.

---

## PARTE E: Formato de producto

```json
{
  "id": "6ae8e577200a750008720a81",
  "title": "Cepillo de Limpieza Aceite Removedor de Película",
  "category": "Baño y Limpieza",
  "price": 12000,
  "costo": 3000,
  "description": "🧽 Título\nUna frase de uso.\n✅ Característica 1\n🧴 Característica 2",
  "img": "https://…/foto1.jpg",
  "imgHi": "https://…/foto1.jpg",
  "images": ["https://…/foto1.jpg", "https://…/foto2.jpg"],
  "stock": false
}
```

- `id`: ID del proveedor.
- `price`: entero, múltiplo de 100 (salvo precio exacto de Santi).
- `costo`: precio del proveedor al cargar. Campo nuevo e interno. Los productos viejos todavía no lo tienen: completarlo en el primer chequeo.
- `stock`: sólo se escribe cuando es `false`.
- El archivo es una lista plana de productos. Antes de guardar, comprobar que sea JSON válido y que no haya IDs repetidos.
- (El ejemplo de arriba es sólo de formato: los números no son datos reales.)

---

## PARTE F: Cómo se lee el proveedor (método que ya funcionó)

El catálogo viene incrustado en la página del proveedor.

1. Abrir `https://pency.app/revoleoficial` en un navegador.
2. Leer: `JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.products`.
3. Cada producto trae: `id`, `title`, `category`, `price`, `images`, `description` y `type` (disponibilidad).
4. El navegador tiene un límite de unos 50.000 caracteres por lectura. Dividir en partes de 250 a 600 productos.
5. Truco de lectura: reemplazar el cuerpo con `document.body.innerHTML='<pre id="__dump">'` y escribir el texto con `textContent=JSON.stringify(…)`, después leer con "get page text".
6. Siempre pedir los datos en el momento. Nunca reusar partes guardadas de otra sesión.

Limitaciones aprendidas:
- Desde el entorno en la nube, el acceso directo al proveedor, a sus imágenes y a `primeramano.github.io` estuvo bloqueado. Por eso se usó el navegador. En la computadora de Santi probablemente funcione directo.
- Para leer archivos del repositorio, `raw.githubusercontent.com` funciona.
- No se pueden verificar imágenes con herramientas de consola cuando el sitio de imágenes está bloqueado: usar el navegador o confiar en los datos del proveedor.
- Si no hay acceso, avisar a Santi antes de probar otras vías.

---

## PARTE G: Flujos de trabajo (exactamente cómo lo hacemos)

### G1. Chequeo general de stock y precios (semanal o a pedido)
1. Leer proveedor en vivo (Parte F).
2. Leer `data/products.json`.
3. Cruzar por ID. Para los que no coinciden por ID, cruzar por nombre (el proveedor a veces vuelve a publicar el mismo producto con ID nuevo).
4. Por cada producto:
   - Proveedor no disponible → poner `"stock": false`.
   - Proveedor disponible y tienda sin stock → quitar `stock` (vuelve a estar en stock).
   - Precio menor a `round(costo×1,35)` → corregir. **Revisar todos los productos, no sólo los que están por debajo del costo.**
   - Guardar `costo` actualizado.
5. Si el proveedor cambió el ID de un producto, actualizar el ID y el costo, no duplicar.
6. Producto que ya no existe en el proveedor: marcar sin stock, no borrar.
7. Armar resumen: cuántos precios cambian, cuántos quedan sin stock, cuántos vuelven.
8. Versión de prueba → Santi aprueba → publicar.

### G2. Agregar productos pedidos por nombre
1. Santi da nombres (a veces mal escritos, con sinónimos).
2. Buscar cada uno en el proveedor en vivo (por palabras clave, no sólo nombre exacto). Si el pedido es "todo lo de la categoría X", traer todo lo que figure en stock.
3. Clasificar: **en stock**, **sin stock**, **no encontrado**.
4. Revisar que no estén ya en la tienda (por ID y por nombre).
5. Armar el producto: título limpio, categoría (Parte D), precio ×1,35, `costo`, descripción (Parte H), fotos del proveedor.
6. Si Santi dio un precio exacto, usarlo y avisar.
7. Mostrar el listado en el reporte con precio, categoría y cuántos son nuevos.
8. Versión de prueba → aprobación → publicar.

### G3. Cambios puntuales que pide Santi
- Ejemplos reales: marcar un producto sin stock, fijar un precio exacto, cambiar categoría, ajustar envío.
- Hacerlo, probar, reportar, esperar aprobación.

### G4. Cambios de código (envíos, checkout, panel)
- Pedirlos con una propuesta corta. Se aplican en versión de prueba.
- Antes de publicar revisar que el archivo no tenga errores de sintaxis.
- El checkout calcula el envío con `shippingCost(pago, entrega)` (domicilio 9000, sucursal 7900, resto 0) y `envioLabel()` para el texto. El pedido guarda el campo `sucursal` y el mensaje de WhatsApp incluye la línea "Sucursal:".

### G5. Cómo se publica
- Con Git: cambios en una rama de prueba, revisión de Santi, después se unen a `main` (GitHub Pages publica solo).
- Alternativa que ya usamos: subir el archivo desde la página de GitHub (`…/upload/main/data`) con un mensaje de commit claro.
- Después de publicar, mirar el historial de commits para confirmar que quedó.

---

## PARTE H: Descripciones (formato fijo)

```
[emoji] Nombre del producto
Una frase de uso o beneficio.
✅ Característica 1
[emoji] Característica 2
[emoji] Uso ideal
```

Máximo 4 viñetas. Sin precios. Sin nombre del proveedor. Tono simple, en español neutro de Argentina.

---

## PARTE I: Autonomía

**Hace solo, sin preguntar**
- Leer repositorio y proveedor.
- Chequeos de stock y precios (G1).
- Agregar productos pedidos por nombre (G2).
- Corregir precios por debajo del margen.
- Marcar sin stock lo que el proveedor ya no tiene.
- Escribir títulos y descripciones según las reglas.
- Preparar versiones de prueba.

**Pide permiso antes**
- Publicar (siempre).
- Borrar productos.
- Cambiar precios por fuera de la fórmula, salvo pedido de Santi.
- Crear categorías.
- Cambiar código de pagos, envíos, carrito o diseño.
- Cambiar de hosting o usar un servicio nuevo o con costo.

**Nunca**
- Tocar la consola de Firebase ni claves.
- Ver o cambiar datos personales de clientes.
- Escribir contraseñas, claves o tokens en archivos.
- Mencionar al proveedor en la tienda.
- Mandar mensajes a clientes.

---

## PARTE J: Primera sesión en Claude Code (en orden)

1. Dar acceso al repositorio y abrir la carpeta del proyecto.
2. Crear `CLAUDE.md` con la Parte A y guardar este documento como `PLAN.md`.
3. **Inventario:** leer todos los archivos y responder qué hace cada uno, cuántos productos hay, qué pestañas tiene el panel y qué campos tiene el editor.
4. **Auditoría del panel:** comparar con la Parte C y entregar lista "ya está / falta". Sin cambiar nada.
5. **Auditoría del catálogo:** G1 en modo "sólo reporte".
6. **Plan de trabajo:** orden de tareas con tiempo estimado. Santi aprueba.
7. **Ejecutar** por bloques, en versión de prueba.
8. Santi prueba en celular y aprueba.
9. Publicar.

Primera tarea sugerida: terminar el editor (C2) y los pedidos (C3), porque es lo que más tiempo le ahorra a Santi desde el celular. Segunda: automatizar G1.

---

## PARTE K: Lecciones de errores que ya pasaron (no repetir)

1. **Datos viejos:** se usaron partes del catálogo capturadas días antes y salieron "no encontrado" y "sin stock" falsos para productos que sí estaban (cinta caminadora, mancuernas, kit de ejercicio, pistolas de agua). Regla: siempre en vivo.
2. **Precios flojos:** una auditoría sólo marcó productos por debajo del costo y dejó pasar los que estaban con margen menor al 35% (un masajeador a $51.100 con costo $48.000). Regla: recalcular el precio de **todos** los productos con la fórmula.
3. **Productos relistados:** los ventiladores industriales 26" y 30" volvieron al proveedor con ID nuevo y más caros (liquidación, costo $130.000 y $150.000). La tienda tenía el precio viejo, por debajo del costo. Regla: cruzar también por nombre y actualizar ID y precio.
4. **Duplicados:** una sincronización creó dos veces una mandolina con el mismo ID. Regla: revisar IDs repetidos antes de guardar.
5. **Edición manual de Santi:** a veces Santi edita el mismo producto a mano. Antes de pisar un precio, avisar que había una diferencia.
6. **Archivos grandes en el navegador:** dividir en partes y verificar que el JSON quedó completo.
7. **Palabras prohibidas:** el nombre del proveedor no puede aparecer en la tienda.
8. **Lenguaje:** Santi pidió que no se use lenguaje profesional ni técnico. Explicar en simple.
9. **Ahorrar créditos:** Santi no quiere que se gaste de más en reparar errores propios. Hacer bien al primer intento y validar contra el proveedor antes de publicar.

---

## PARTE L: Historial de cambios ya publicados (contexto)

- Envío rearmado: domicilio $9.000 y retiro en sucursal Andreani $7.900 (commit `eada668`).
- Auditoría de stock y precios: 27 productos que volvieron a estar en stock, 33 marcados sin stock, precios recalculados a ×1,35 (commit `413107e`).
- 25 productos nuevos en Aire Libre y Jardín (commit `3fbe118`).
- Cepillo de limpieza (precio fijado a mano en $12.000), colchones y tablas de cocina de acero (commits `faf67fb`, `e23f3c9`, `863141f`).

---

## PARTE M: Qué no preguntar

- Hosting: GitHub Pages.
- Costo: todo debe quedar gratis. Si algo no lo es, avisar antes.
- Margen: ×1,35, salvo indicación.
- Categorías: las de la Parte D.
- Idioma: español rioplatense.
- Cómo se prueba: versión de prueba y aprobación de Santi.
- Fuente de datos: el proveedor en vivo (https://pency.app/revoleoficial) y la tienda (https://primeramano.github.io/) para verificar lo publicado.
