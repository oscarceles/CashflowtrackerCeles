# Instrucciones para agentes

- Mantener `WIKI.md` sincronizado con el comportamiento del producto. En cada modificacion o fix, actualizar en el mismo trabajo las secciones afectadas y agregar una linea al historial del wiki cuando cambie codigo, interfaz, datos, calculos, autenticacion, almacenamiento o despliegue.
- Documentar el comportamiento implementado, no una intencion futura. Si una regla o flujo no pudo verificarse, indicarlo como pendiente de confirmar en lugar de afirmarlo como hecho.
- No incluir valores de `.env`, tokens, claves privadas ni datos sensibles en `WIKI.md`, `README.md` u otra documentacion versionada.