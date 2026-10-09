# AnimeHub API

AnimeHub API reúne el catálogo, los episodios y los enlaces de descarga que usan los clientes de AnimeHub. Aquí viven la consulta a la fuente, la persistencia en PostgreSQL y los trabajos de resolución de enlaces. La Web y cualquier otro cliente consumen el mismo contrato HTTP.

- API pública: <https://animehub-api.duardo.dev/api/v1>
- Referencia interactiva: <https://animehub-api.duardo.dev/docs>
- Contrato publicado: <https://animehub-api.duardo.dev/openapi.json>
- Web: <https://animehub.duardo.dev/>
- Código de la Web: [animehub-frontend](https://github.com/duardor968/animehub-frontend)

## Qué hace

- Sirve una portada con novedades, un catálogo con búsqueda y filtros, y un horario semanal estimado.
- Devuelve fichas de anime, relaciones y episodios paginados.
- Resuelve enlaces por episodio, con preferencia SUB y alternativa DUB cuando corresponde.
- Procesa rangos y series completas como trabajos en segundo plano, con progreso, reintentos y cancelación.

AnimeAV1 es la única fuente actual. La API interpreta sus respuestas JSON de SvelteKit, valida los datos y conserva una copia normalizada en PostgreSQL. La portada puede servir la última información disponible mientras se actualiza en segundo plano; no depende de consultar la fuente en cada visita.

Los trabajos de descarga resuelven enlaces. La transferencia de archivos la realiza el cliente o su gestor de descargas. No hay cuentas de usuario ni biblioteca personal en este servicio.

## Arranque local

Necesitas Node.js 24, pnpm 12.10.1 y una base PostgreSQL de desarrollo. CI usa PostgreSQL 18. Ejecuta los comandos desde la raíz de este repositorio.

```sh
corepack enable
corepack prepare pnpm@12.10.1 --activate
pnpm install --frozen-lockfile
```

Copia `.env.example` a `.env` y ajusta `DATABASE_URL` a tu base local. El usuario y la base deben existir antes de aplicar las migraciones; los valores del ejemplo son solo para desarrollo. Después:

```sh
pnpm prisma:validate
pnpm prisma:migrate
pnpm prisma:generate
pnpm dev
```

La API escucha en `http://localhost:8000/api/v1`. Puedes comprobarla sin abrir la Web:

```sh
curl http://localhost:8000/api/v1/health/ready
```

Swagger queda en `http://localhost:8000/docs` y el contrato en `http://localhost:8000/openapi.json`.

### Configuración

| Variable            | Para qué sirve                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Conexión a PostgreSQL, incluida la persistencia de los trabajos.                       |
| `PORT`              | Puerto HTTP; por defecto, `8000`.                                                      |
| `CORS_ORIGINS`      | Orígenes permitidos, separados por comas. En local: `http://localhost:3000`.           |
| `ANIMEAV1_BASE_URL` | Origen de la fuente; por defecto, `https://animeav1.com`.                              |
| `SOURCE_USER_AGENT` | Identificación de las solicitudes a la fuente.                                         |
| `JOBS_ENABLED`      | Activa los trabajadores y refrescos programados. Déjalo en `true` para usar los lotes. |
| `TRUST_PROXY`       | Proxies fiables para `X-Forwarded-For` (`true`, saltos o IP/CIDR); si falta, ninguno.  |
| `LOG_LEVEL`         | Nivel de los logs; por defecto, `info`.                                                |

Mantén `.env` fuera de Git. La Web no necesita conocer `DATABASE_URL`.

## Contrato de la API

[`openapi.json`](openapi.json) es la especificación versionada de este repositorio. Se genera a partir de los controladores y DTO de NestJS:

```sh
pnpm openapi:generate
pnpm openapi:check
```

El primer comando actualiza el archivo. El segundo vuelve a generarlo y falla si difiere de la versión registrada en Git. Revisa e incluye los cambios de contrato junto con el código que los produce.

Las rutas de negocio están bajo `/api/v1`:

| Recurso                | Rutas principales                                                        |
| ---------------------- | ------------------------------------------------------------------------ |
| Descubrimiento         | `GET /home`, `GET /catalog`, `GET /catalog/suggestions`, `GET /schedule` |
| Anime y episodios      | `GET /anime/:slug`, `GET /anime/:slug/episodes`                          |
| Enlaces de un episodio | `POST /anime/:slug/downloads/resolve`                                    |
| Lotes                  | `POST /anime/:slug/download-jobs`, `GET /download-jobs/:id`              |
| Control de trabajos    | `POST /download-jobs/:id/retry`, `POST /download-jobs/:id/cancel`        |
| Salud                  | `GET /health/live`, `GET /health/ready`                                  |
| Sitemap                | `GET /sitemap/anime`                                                     |

Las respuestas de negocio usan `data` y, cuando corresponde, `meta`; los errores siguen Problem Details. Consultar o modificar un trabajo exige el token de capacidad que devuelve su creación. Es un token temporal del trabajo, no una sesión de usuario, y debe tratarse como un secreto.

Cada cliente fija una revisión del contrato y genera sus propios tipos. La API no escribe archivos en el repositorio de la Web. Un cambio incompatible necesita coordinar a los consumidores y, si corresponde, una nueva versión de las rutas.

## Trabajar en el código

El servidor usa NestJS sobre Fastify, Prisma y pg-boss. Las versiones exactas están en [`package.json`](package.json) y el lockfile.

- `src/source/`: acceso a AnimeAV1 y validación de sus respuestas.
- `src/projection/` y `src/home/`: datos persistidos, portada y refrescos.
- `src/catalog/`, `src/anime/` y `src/schedule/`: consultas públicas.
- `src/downloads/`: resolución de enlaces y trabajos por lotes.
- `prisma/`: esquema y migraciones.

Antes de dar un cambio por terminado:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm test:audit
pnpm audit:ci
pnpm build
```

La integración con PostgreSQL se ejecuta aparte con `pnpm test:integration`. Define `TEST_DATABASE_URL` en la terminal y úsala solo con una base de pruebas: la suite crea y elimina un esquema temporal y requiere esos permisos. Sin esa variable, `pnpm test` omite esta integración; una pasada de tests unitarios no la sustituye.

CI también comprueba migraciones, secretos y la construcción de la imagen. La auditoría bloquea vulnerabilidades altas o críticas de producción salvo las excepciones ya documentadas en `pnpm-workspace.yaml`; los avisos exclusivos de desarrollo se reportan por separado.

## Despliegue

El [`Dockerfile`](Dockerfile) está en la raíz y construye únicamente la API:

```sh
docker build -t animehub-api .
```

La imagen expone el puerto `8000`. Al arrancar aplica las migraciones pendientes y luego inicia el servidor. Configura `DATABASE_URL` y el resto del entorno en el servicio de despliegue; `localhost` dentro del contenedor se refiere al propio contenedor.

- `/api/v1/health/live` comprueba que el proceso responde.
- `/api/v1/health/ready` comprueba también la conexión a PostgreSQL.
- `CORS_ORIGINS` debe incluir `https://animehub.duardo.dev` en producción.

Esta separación conserva el dominio público y debe reutilizar la base y el esquema existentes. Cambiar de repositorio no requiere empezar con una base vacía. Antes de sustituir una instancia, revisa las migraciones y los trabajos activos; un healthcheck correcto no garantiza por sí solo un despliegue sin interrupciones.

Este repositorio nace de la separación de `apps/api` del [monorepo AnimeHub Web](https://github.com/duardor968/animehub-web), conservando su historial. El monorepo anterior está archivado y se conserva como referencia histórica.

## Licencia

[GNU AGPL v3 o posterior](LICENSE).
