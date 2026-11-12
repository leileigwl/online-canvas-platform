<div align="center">

# FlowCanvas

**Lienzo Infinito de IA y Estudio Creativo Multi-Agente de Código Abierto y Autoalojado**

*Espacio visual infinito · Generación y edición BYOK multi-proveedor · Orquestación LangGraph vía SSE · Seguridad de nivel producción*

[![License: MIT](https://img.shields.io/badge/License-MIT-111111?style=flat-square)](./LICENSE)
[![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)](./apps/api/pyproject.toml)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?style=flat-square&logo=fastapi&logoColor=white)](./apps/api)
[![LangGraph](https://img.shields.io/badge/LangGraph-Multi--Agent-1C3C3C?style=flat-square)](./apps/worker)
[![React 19](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](./apps/web)
[![Docker Compose](https://img.shields.io/badge/Docker-6--Service%20Stack-2496ED?style=flat-square&logo=docker&logoColor=white)](./infra/compose.yaml)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · **Español**

<br />

<img src="./docs/assets/canvas-workspace.png" alt="FlowCanvas Lienzo Infinito y Estudio Multi-Agente" width="100%" />

</div>

---

## ¿Por qué FlowCanvas?

La mayoría de las herramientas de imagen con IA encierran al creador en un chat lineal, mientras que las pizarras clásicas añaden la IA como un complemento desconectado. **FlowCanvas** unifica un **lienzo infinito estilo galería Warm Ivory**, **generación de imágenes BYOK multi-proveedor** y un sistema **multi-agente LangGraph observable en tiempo real**, todo listo para autoalojamiento seguro con Docker Compose.

- **Creación centrada en el lienzo**: Desplazamiento y zoom fluidos, selección múltiple (`V`), pincel libre (`B`), texto en línea (`T`), alineación local y una capa dedicada `dragLayer` en Konva. Haz clic en cualquier imagen del lienzo para vincularla como referencia (`Ref 1 / Ref 2`).
- **Libertad total (Multi-BYOK)**: Adaptadores nativos para **Google Gemini (Nano Banana)**, **OpenAI (`gpt-image-1` / `gpt-image-2.5` y pasarelas compatibles)**, **Alibaba DashScope (`qwen-image-2.0`)**, **Volcengine Ark (`Seedream`)** y **SiliconFlow (`Kolors`)**, junto con cualquier LLM compatible con OpenAI.
- **Ejecución Multi-Agente observable (SSE v2)**: Sigue el flujo `Coordinator → Planner → Canvas Editor → Reviewer` con tarjetas de herramientas y pensamiento en vivo, memoria persistente **Harness** (`canvas_memories`) y deshacer en lote con un clic.
- **Seguridad para producción**: Cifrado Fernet de claves API, protección SSRF mediante DNS Pinning, limitación deslizante en Redis, bloqueos de fila en PostgreSQL y verificación de correo por código OTP vía SMTP SSL.

---

## Recorrido visual

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="./docs/assets/studio-home.png" alt="Inicio de FlowCanvas" width="100%" />
      <p align="center"><b>Inicio del Estudio y Lanzador Rápido</b><br /><sub>Inicia un lienzo con 0, 1 o más imágenes de referencia y modelos preconfigurados.</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="./docs/assets/canvas-workspace.png" alt="Lienzo Infinito y Panel Agente" width="100%" />
      <p align="center"><b>Lienzo Infinito y Colaboración Multi-Agente</b><br /><sub>Barra flotante, minimapa inferior, exportación PNG 2× limpia y memoria Harness en vivo.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="./docs/assets/model-settings.png" alt="Configuración BYOK Multi-Proveedor" width="100%" />
      <p align="center"><b>Centro de Modelos BYOK Multi-Proveedor</b><br /><sub>Gestiona múltiples adaptadores de imagen y LLMs con cifrado Fernet en reposo.</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="./docs/assets/email-auth.png" alt="Autenticación con Código de Correo" width="100%" />
      <p align="center"><b>Autenticación OTP por Correo y Sesiones</b><br /><sub>Registro con código de 6 dígitos, acceso por usuario o correo y restablecimiento que revoca sesiones.</sub></p>
    </td>
  </tr>
</table>

---

## Arquitectura del Sistema

```mermaid
flowchart LR
  User["Navegador (React 19 + Konva)"] -->|HTTP / SSE| Web["Proxy Inverso Caddy 2 (:8080)"]
  Web -->|SPA Estática| Dist["Bundle Vite"]
  Web -->|/api/*| API["Backend FastAPI (:8000)"]

  API -->|SQLAlchemy Asíncrono| PG[("PostgreSQL 18")]
  API -->|Límites / Colas| Redis[("Redis 7")]
  API -->|Almacenamiento Privado| MinIO[("MinIO S3")]
  API -->|Encolar Ejecución| Redis
  API -->|Correo OTP| SMTP["SMTP SSL (:465)"]

  Worker["ARQ Worker + LangGraph"] -->|Tareas y Checkpoints| Redis
  Worker -->|Estado y Memoria| PG
  Worker -->|Guardar Imágenes| MinIO
  Worker -->|BYOK HTTPS + DNS Pinning| Models["LLM y 5 Proveedores de Imagen"]
```

---

## Inicio Rápido (Docker Compose)

```bash
git clone https://github.com/leileigwl/online-canvas-platform.git
cd online-canvas-platform
cp infra/compose.env.example .env
# Edita .env con APP_SECRET_KEY segura, contraseñas de DB/Redis/MinIO y ajustes SMTP
docker compose --project-directory "$PWD" -f infra/compose.yaml --env-file .env up -d --build
```

Abre **http://localhost:8080** en tu navegador. Consulta [`README.md`](./README.md) y [`docs/`](./docs) para instrucciones de desarrollo local (`uv` + `pnpm`) y arquitectura completa.

---

## Licencia

Distribuido bajo la licencia [MIT License](./LICENSE).
