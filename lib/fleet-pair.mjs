import { formatMessage as tr } from '../public/i18n-core.js';

// Reuse the gateway's PIN verifier and login attempt bucket. Never mounted on desktop.
export async function pairFleetDevice({
  req,
  res,
  devices,
  validCode,
  isCurrent,
  attempts,
  peer,
  now,
  respond,
}) {
  const entry = attempts.get(peer) || { count: 0, until: now + 10 * 60 * 1000 };
  if (entry.count >= 5) {
    res.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
    return respond(res, 429, { error: tr('server.trop_de_tentatives_reessayez_dans_quelques_minutes') });
  }
  // Bound successful pairing too; a valid PIN must not create unbounded devices.
  entry.count++;
  if (attempts.size >= 256 && !attempts.has(peer)) attempts.delete(attempts.keys().next().value);
  attempts.set(peer, entry);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    return respond(res, 415, { error: tr('server.un_corps_json_est_requis') });
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024)
      return respond(res, 413, { error: tr('server.la_demande_depasse_la_taille_autorisee') });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return respond(res, 400, { error: tr('server.la_demande_json_est_invalide') });
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== 'object' ||
    Object.keys(body).some((key) => !['pin', 'deviceName'].includes(key))
  )
    return respond(res, 400, { error: tr('server.la_demande_json_est_invalide') });
  if (!isCurrent() || !validCode(body.pin))
    return respond(res, 401, { error: tr('server.code_incorrect_reessayez') });
  try {
    const paired = await devices.pair(body.deviceName);
    if (!isCurrent()) {
      await devices.revoke(paired.deviceId);
      return respond(res, 401, {
        error: tr('server.saisissez_le_nouveau_code_d_acces_sur_la_page_d_accueil'),
      });
    }
    return respond(res, 200, paired);
  } catch (error) {
    return respond(res, error.status || 500, {
      error: error.status ? error.message : tr('server.une_erreur_est_survenue'),
    });
  }
}
