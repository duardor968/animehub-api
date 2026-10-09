# Plan: caché propia de imágenes en WebP

Estado: **planificado, sin implementar**. Este documento recoge el diseño acordado para servir las imágenes de AnimeHub desde nuestro propio origen, convertidas a WebP y con una caché de vida muy larga. Su implementación requiere decidir dónde se guardan los archivos en producción, por lo que no se hizo en la tanda de pulido de octubre de 2026.

## Por qué

PageSpeed Insights (móvil, 7 oct 2026) estima **538 KiB de ahorro solo en la portada** si las imágenes de la fuente se entregaran en un formato moderno y al tamaño mostrado:

| Recurso                                             | Tamaño  | Ahorro estimado |
| --------------------------------------------------- | ------- | --------------- |
| `cdn.animeav1.com/backdrops/197.jpg` (LCP)          | 349 KiB | 332 KiB         |
| `cdn.animeav1.com/backdrops/3560.jpg`               | 115 KiB | 98 KiB          |
| Portadas `covers/*.jpg` (25–40 KiB c/u)             | —       | 10–24 KiB c/u   |
| Capturas `screenshots/{anime}/{n}.jpg` (~9 KiB c/u) | —       | 4–6 KiB c/u     |

El fondo del carrusel es el elemento LCP de la portada. Tras el pulido, el LCP móvil medido en local bajó de ≈8 s a ≈4,4 s, y el peso de la imagen es ahora la mayor parte de lo que queda.

## Lo que sabemos de las imágenes

- Las URL son **deterministas** y la API las construye en `src/source/animeav1.service.ts`:
  - `https://cdn.animeav1.com/covers/{animeId}.jpg` (póster 2:3)
  - `https://cdn.animeav1.com/backdrops/{animeId}.jpg` (fondo ≈4,75:1)
  - `https://cdn.animeav1.com/screenshots/{animeId}/{n}.jpg` (fotograma 16:9, solo 220×124)
- El CDN responde `cache-control: public, max-age=31536000, immutable` y envía `ETag` y `Last-Modified`, así que el contenido de una URL casi nunca cambia y se puede revalidar de forma barata.
- La Web usa `referrerPolicy="no-referrer"` en las imágenes; las peticiones desde servidor no envían referrer, así que la descarga del lado de la API no debería verse afectada por protecciones de hotlinking. Hay que confirmarlo en producción.
- Las capturas de episodio son de solo 220×124: convertirlas reduce bytes, pero no las hace más nítidas. Para tarjetas grandes conviene seguir usando el fondo del anime como alternativa.

## Diseño propuesto

### 1. Endpoint de medios en la API

```
GET /api/v1/media/{kind}/{animeId}.webp?w={ancho}
GET /api/v1/media/screenshots/{animeId}/{n}.webp?w={ancho}
kind ∈ covers | backdrops
w ∈ conjunto cerrado de anchos (p. ej. 160, 320, 480, 640, 960, 1280, 1920)
```

- Valida `kind`, ids numéricos y `w` contra la lista blanca. Así nadie puede usar el endpoint como proxy abierto ni llenar el disco con tamaños arbitrarios.
- **Acierto de caché:** sirve el archivo guardado con:
  - `Content-Type: image/webp`;
  - `Cache-Control: public, max-age=31536000, immutable`;
  - un `ETag` propio derivado del ETag de origen más el ancho.
- **Fallo de caché:**
  1. descarga el original (con un timeout y un tamaño máximo, p. ej. 5 MB);
  2. lo convierte con `sharp` (`resize({ width, withoutEnlargement: true })`, `webp({ quality: 72, effort: 4 })`);
  3. lo guarda y lo sirve.

  Las peticiones concurrentes para la misma clave deben esperar a la misma conversión (single-flight mediante un `Map<string, Promise>` en el proceso, más un lock por clave si hay varias réplicas).

- **Error de origen:** 404 si el CDN da 404, y 502 con `Cache-Control: no-store` si falla. La Web ya cae al fondo y después al marcador de marca cuando una imagen falla (`AnimeImage`).
- **Opcional:** AVIF con negociación por `Accept`. Es más lento de codificar; empezar solo con WebP.

### 2. Almacenamiento (decisión pendiente)

| Opción                                   | Pros                                                               | Contras                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Volumen persistente** del contenedor   | Lo más simple; sin servicios nuevos.                               | Se pierde si el volumen no persiste; no escala a varias réplicas. |
| **Objeto S3 compatible (Cloudflare R2)** | Sin coste de salida, encaja con Cloudflare delante; multi-réplica. | Credenciales y bucket nuevos.                                     |
| **PostgreSQL `bytea`**                   | Sin infraestructura nueva; backups incluidos.                      | Engorda la base y sus backups; no es lo que mejor hace Postgres.  |

Recomendación: **R2 (o volumen persistente si se quiere empezar ya)**, con una tabla de metadatos en PostgreSQL que, en cualquier caso, permite deduplicar, reintentar y purgar:

```prisma
model MediaAsset {
  id           String   @id @default(cuid())
  sourceUrl    String
  width        Int
  format       String   // "webp"
  storageKey   String   @unique
  sourceEtag   String?
  bytes        Int
  status       String   // READY | FAILED
  failureCount Int      @default(0)
  lastCheckedAt DateTime
  createdAt    DateTime @default(now())

  @@unique([sourceUrl, width, format])
}
```

### 3. Caducidad «que tarde mucho en expirar»

- Clientes y Cloudflare: `max-age=31536000, immutable`. La URL no cambia mientras el contenido no cambie.
- Revalidación de origen: un trabajo de pg-boss semanal o mensual revisa con `HEAD`/`If-None-Match` los recursos más vistos (por `lastCheckedAt`). Si el `ETag` de origen cambia, regenera el archivo y **cambia la URL pública**. Por ejemplo, la API puede exponer `posterUrl` con un sufijo de versión `?v={hashCorto}` para invalidar sin depender de purgas.
- Purga: borrar recursos no pedidos en N meses (opcional; el espacio de un catálogo de unos pocos miles de títulos es pequeño).

### 4. Cómo lo consume la Web

- Opción A, **la API reescribe las URL**: `serializeAnime`, `serializeEpisode` y `serializeRelation` en `src/common/serializers.ts` devuelven URL propias en lugar de las del CDN. Lo más limpio: la Web no cambia salvo `next.config.ts` (`images.remotePatterns` y la CSP `img-src` deben incluir el origen de la API).
- Opción B, **la Web construye las URL**: añadir a `AnimeImage` un `loader` que traduzca `cdn.animeav1.com/...jpg` a `/api/v1/media/...webp?w=` y genere `srcset` con los anchos permitidos. Con `sizes` correctos (ya definidos en los componentes), el navegador elige el ancho.
- En cualquier caso:
  - mantener `cdn.animeav1.com` como alternativa en `fallbackSrc` mientras se estabiliza;
  - quitar `images.unoptimized` solo si se usa el loader de la opción B (no el optimizador de Next).

### 5. Alternativa rápida sin base de datos

Activar el optimizador integrado de Next.js. En `next.config.ts`:

- quitar `images.unoptimized` y el `unoptimized` de `AnimeImage`;
- `formats: ["image/avif", "image/webp"]`;
- `minimumCacheTTL: 31536000`.

Next descarga el original, lo convierte y lo guarda en `.next/cache/images`. Requisitos:

- volumen persistente para esa carpeta, o la caché se pierde en cada despliegue;
- CPU suficiente en el contenedor de la Web (`sharp` ya está permitido en `pnpm-workspace.yaml`);
- añadir `'self'` a la CSP `img-src`, que ya lo incluye.

Es la vía más corta para recoger la mayor parte del ahorro. El endpoint de la API es mejor a largo plazo, porque otros clientes también lo aprovechan y no depende de la Web.

## Pasos sugeridos

1. Decidir el almacenamiento (R2, volumen o `bytea`).
2. Añadir `sharp` a la API, el módulo `media` (controlador, servicio, single-flight, lista blanca de anchos) y la tabla `MediaAsset` con su migración.
3. Tests: validación de parámetros, conversión (fixture JPEG), concurrencia, errores de origen y cabeceras de caché.
4. Reescribir las URL (opción A) detrás de una variable `MEDIA_BASE_URL`; sin ella, se siguen sirviendo las del CDN.
5. Actualizar el contrato de la Web si cambia la forma de las URL, más la CSP `img-src` y `remotePatterns`.
6. Medir con PageSpeed antes y después (LCP móvil, peso total).
