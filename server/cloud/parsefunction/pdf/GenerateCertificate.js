import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { formatDateTime } from '../../../Utils.js';
import GenerateLocationMap from './GenerateLocationMap.js'; // HEX_MAP_CERT

const formatDateStr = (dateStr, DateFormat, timezone, Is12Hr) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return formatDateTime(date, DateFormat, timezone, Is12Hr);
};

// HEX_MAP_CERT: decimal degrees -> degrees/minutes/seconds, matching the
// format used by commercial e-sign audits
const toDMS = (lat, lng) => {
  const fmt = (v, pos, neg) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const sec = (((a - d) * 60) - m) * 60;
    return `${d}\u00B0${m}\u2032${sec.toFixed(0)}\u2033${v >= 0 ? pos : neg}`;
  };
  return `${fmt(lat, 'N', 'S')} ${fmt(lng, 'E', 'W')}`;
};

export default async function GenerateCertificate(docDetails) {
  const timezone = docDetails?.ExtUserPtr?.Timezone || '';
  const Is12Hr = docDetails?.ExtUserPtr?.Is12HourTime || false;
  const DateFormat = docDetails?.ExtUserPtr?.DateFormat || 'MM/DD/YYYY';
  const pdfDoc = await PDFDocument.create();
  // `fontBytes` is used to embed custom font in pdf
  const fontBytes = fs.readFileSync('./font/times.ttf'); //
  pdfDoc.registerFontkit(fontkit);
  const timesRomanFont = await pdfDoc.embedFont(fontBytes, { subset: true });
  // HEX_FORM_V5: sans faces for the official-form layout
  const sansBold = await pdfDoc.embedFont(
    fs.readFileSync('/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf'), { subset: true })
  const sans = await pdfDoc.embedFont(
    fs.readFileSync('/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf'), { subset: true })
  const mono = await pdfDoc.embedFont(
    fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'), { subset: true })
  const pngUrl = fs.readFileSync('./images/logo.png').buffer;
  const naSignUrl = fs.readFileSync('./images/na_sign.png').buffer;
  const nasign = await pdfDoc.embedPng(naSignUrl);
  const pngImage = await pdfDoc.embedPng(pngUrl);
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const startX = 15;
  const startY = 15;
  const borderColor = rgb(0.12, 0.12, 0.12);
  const titleColor = rgb(0, 0.2, 0.4); //rgb(0, 0.53, 0.71);
  const titleUnderline = rgb(0, 0.2, 0.4); // rgb(0.12, 0.12, 0.12);
  const title = 25;
  const subtitle = 16;
  const text = 13;
  const signertext = 13;
  const timeText = 11;
  const textKeyColor = rgb(0.12, 0.12, 0.12);
  const textValueColor = rgb(0.3, 0.3, 0.3);
  const completedAt = docDetails?.completedAt ? new Date(docDetails?.completedAt) : new Date();
  const completedAtperTimezone = formatDateStr(completedAt, DateFormat, timezone, Is12Hr);
  const completedUTCtime = completedAtperTimezone;
  const signersCount = docDetails?.Signers?.length || 1;
  const generateAt = docDetails?.completedAt ? new Date(docDetails?.completedAt) : new Date();
  const generatedAtperTimezone = formatDateTime(generateAt, DateFormat, timezone, Is12Hr);
  const generatedUTCTime = generatedAtperTimezone;
  const generatedOn = 'Generated On ' + generatedUTCTime;
  const textWidth = timesRomanFont.widthOfTextAtSize(generatedOn, 12);
  const margin = 30;
  const maxX = width - margin - textWidth; // Ensures text stays inside the border with 30px margin
  const OriginIp = docDetails?.OriginIp || '';
  const company = docDetails?.ExtUserPtr?.Company || '';
  const documentHash = docDetails?.DocumentHash || '';
  const createdAt = docDetails?.DocSentAt?.iso || docDetails.createdAt;
  const createdAtperTimezone = formatDateStr(createdAt, DateFormat, timezone, Is12Hr);
  const IsEnableOTP = docDetails?.IsEnableOTP || false;
  const placeholders = Array.isArray(docDetails?.Placeholders) ? docDetails.Placeholders : [];
  // HEX_CERT_V3: AuditTrail holds one entry per EVENT (Viewed, Signed, ...).
  // Rendering it directly produced a blank "signer" block for every extra
  // event. Collapse to one entry per signer, preferring the Signed record.
  const _rawAudit = docDetails?.AuditTrail?.filter(x => {
    if (!x?.UserPtr?.objectId) return false;
    return true;
  }) || [];
  const _bySigner = new Map();
  for (const _e of _rawAudit) {
    const _k = _e.UserPtr.objectId;
    const _prev = _bySigner.get(_k);
    if (!_prev) { _bySigner.set(_k, _e); continue; }
    const _rank = (v) => (v?.Activity === 'Signed' ? 2 : v?.Activity === 'Viewed' ? 1 : 0);
    if (_rank(_e) > _rank(_prev)) {
      // keep the richer record but retain the earliest view time
      _e.ViewedOn = _e.ViewedOn || _prev.ViewedOn;
      _bySigner.set(_k, _e);
    } else if (!_prev.ViewedOn && _e.ViewedOn) {
      _prev.ViewedOn = _e.ViewedOn;
    }
  }
  const _signerIds = new Set(
    (Array.isArray(docDetails?.Signers) ? docDetails.Signers : [])
      .map((v) => v?.objectId)
      .filter(Boolean)
  );
  const filteredaudit = Array.from(_bySigner.values()).filter(
    (e) => _signerIds.size === 0 || _signerIds.has(e?.UserPtr?.objectId) // HEX_CERT_V4
  );
  const toTs = v => {
    if (!v) return 0;
    if (typeof v === 'object' && v?.iso) return new Date(v.iso).getTime() || 0;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const auditTrail =
    docDetails?.Signers?.length > 0
      ? filteredaudit?.map(x => {
          const data = docDetails.Signers.find(y => y.objectId === x.UserPtr.objectId);
          return {
            ...data,
            ipAddress: x.ipAddress,
            // HEX_GEO_CERT: carry the captured location through to the certificate
            signingLocation: x?.signingLocation,
            userAgent: x?.userAgent,                    // HEX_CERT_V3
            locationAccuracy: x?.locationAccuracy,      // HEX_CERT_V3
            locationStatus: x?.locationStatus,          // HEX_CERT_V3
            signingLatitude: x?.signingLatitude,
            signingLongitude: x?.signingLongitude,
            SignedOn: x?.SignedOn || generatedUTCTime,
            ViewedOn: x?.ViewedOn || x?.SignedOn || generatedUTCTime,
            Signature: x?.Signature || '',
            _signedOnTs: toTs(x?.SignedOn),
          };
        })
      : [
          {
            ...docDetails.ExtUserPtr,
            ipAddress: filteredaudit[0].ipAddress,
            signingLocation: filteredaudit[0]?.signingLocation,
            signingLatitude: filteredaudit[0]?.signingLatitude,
            signingLongitude: filteredaudit[0]?.signingLongitude,
            SignedOn: filteredaudit[0]?.SignedOn || generatedUTCTime,
            ViewedOn: filteredaudit[0]?.ViewedOn || filteredaudit[0]?.SignedOn || generatedUTCTime,
            Signature: filteredaudit[0]?.Signature || '',
            _signedOnTs: toTs(filteredaudit[0]?.SignedOn),
          },
        ];
  if (Array.isArray(auditTrail)) {
    auditTrail.sort((a, b) => (a?._signedOnTs || 0) - (b?._signedOnTs || 0));
  }

  const ownerName = docDetails?.SenderName || docDetails.ExtUserPtr?.Name || 'n/a';
  const ownerEmail = docDetails?.SenderMail || docDetails.ExtUserPtr?.Email || 'n/a';
  const half = width / 2;

  // ------------------------------------------------------------------
  // HEX_FORM_V5 - official-form layout
  // Ruled label/value grid, uppercase tracked headings, navy section
  // bars. Same data as before; only the presentation changed.
  // ------------------------------------------------------------------
  const navy = rgb(17 / 255, 35 / 255, 102 / 255);   // #112366 brand navy (HEX_BLUE)
  const ink = rgb(0.10, 0.11, 0.13);
  const labelGrey = rgb(0.34, 0.37, 0.45);
  const hair = rgb(0.80, 0.82, 0.86);
  const LEFT = 30;
  const RIGHT = width - 30;
  const VAL = 150;

  // tracking emulation - thin spaces make uppercase headings read as caps-spaced
  const sp = (s) => String(s ?? '').toUpperCase().split('').join('\u2009');

  const clampText = (font, str, size, maxW) => {
    let s = String(str ?? '');
    try {
      if (font.widthOfTextAtSize(s, size) <= maxW) return s;
      while (s.length > 4 && font.widthOfTextAtSize(s + '\u2026', size) > maxW) s = s.slice(0, -1);
      return s + '\u2026';
    } catch (e) {
      return s;
    }
  };

  const drawSectionBar = (pg, y, text) => {
    pg.drawRectangle({ x: LEFT, y: y - 4, width: RIGHT - LEFT, height: 15, color: navy });
    pg.drawText(sp(text), {
      x: LEFT + 8, y, size: 7.4, font: sansBold, color: rgb(1, 1, 1),
    });
    return y - 21;
  };

  const drawKV = (pg, y, label, value, opts = {}) => {
    const size = opts.size || 9.6;
    const font = opts.font || sans;
    pg.drawText(sp(label), {
      x: LEFT + 2, y: y + 1, size: 6.7, font: sansBold, color: labelGrey,
    });
    pg.drawText(clampText(font, value, size, RIGHT - VAL - 6), {
      x: VAL, y, size, font, color: opts.color || ink,
    });
    if (opts.rule !== false) {
      pg.drawLine({
        start: { x: LEFT, y: y - 5 },
        end: { x: RIGHT, y: y - 5 },
        color: hair, thickness: 0.5,
      });
    }
    return y - (opts.step || 16);
  };

  // Draw a border on any page
  const drawBorder = (pg) => pg.drawRectangle({
    x: startX, y: startY, width: width - 2 * startX, height: height - 2 * startY,
    borderColor, borderWidth: 1,
  });

  // ---- page 1: header ----
  drawBorder(page);

  // brand mark, top-left, aspect preserved (1158x396 source)
  page.drawImage(pngImage, { x: LEFT, y: 778, width: 120, height: 41 });

  // right-hand issue block
  page.drawText(sp('Certificate ID'), { x: RIGHT - 158, y: 806, size: 6.7, font: sansBold, color: labelGrey });
  page.drawText(clampText(sans, docDetails.objectId, 9, 158), { x: RIGHT - 158, y: 796, size: 9, font: sans, color: ink });
  page.drawText(sp('Generated'), { x: RIGHT - 158, y: 783, size: 6.7, font: sansBold, color: labelGrey });
  page.drawText(clampText(sans, generatedUTCTime, 9, 158), { x: RIGHT - 158, y: 773, size: 9, font: sans, color: ink });

  // title
  page.drawText(sp('Certificate of Completion'), { x: LEFT, y: 746, size: 15, font: sansBold, color: navy });
  page.drawText('Electronic signature record  \u00B7  issued by Rapid Lodgements', {
    x: LEFT, y: 734, size: 7.8, font: sans, color: labelGrey,
  });
  page.drawLine({ start: { x: LEFT, y: 728 }, end: { x: RIGHT, y: 728 }, color: navy, thickness: 1 });
  page.drawLine({ start: { x: LEFT, y: 725.5 }, end: { x: RIGHT, y: 725.5 }, color: navy, thickness: 0.4 });

  // ---- document details ----
  let yCur = drawSectionBar(page, 708, 'Document details');
  yCur = drawKV(page, yCur, 'Document ID', docDetails.objectId);
  yCur = drawKV(page, yCur, 'Document name', docDetails?.Name || '\u2014');
  if (documentHash) {
    yCur = drawKV(page, yCur, 'Document hash (SHA-256)', documentHash, { size: 7.2, font: mono });
  }
  yCur = drawKV(page, yCur, 'Organisation', company || '\u2014');
  yCur = drawKV(page, yCur, 'Created on', createdAtperTimezone || '\u2014');
  yCur = drawKV(page, yCur, 'Completed on', completedUTCtime || '\u2014');
  yCur = drawKV(page, yCur, 'Signers', String(signersCount), { rule: false });

  // ---- document originator ----
  yCur -= 14;
  yCur = drawSectionBar(page, yCur, 'Document originator');
  yCur = drawKV(page, yCur, 'Name', ownerName);
  yCur = drawKV(page, yCur, 'Email', ownerEmail);
  yCur = drawKV(page, yCur, 'IP address', OriginIp || '\u2014', { rule: false });

  // ---- signer / approver blocks ----
  const drawSignerHeader = (pg, y, text) => {
    pg.drawRectangle({ x: LEFT, y: y - 4, width: RIGHT - LEFT, height: 15, color: rgb(0.90, 0.92, 0.95) });
    pg.drawText(sp(text), { x: LEFT + 8, y, size: 7.4, font: sansBold, color: navy });
    return y - 21;
  };

  let currentPage = page;
  let mapSlot = 0;

  const newPage = () => {
    const pg = pdfDoc.addPage();
    drawBorder(pg);
    return pg;
  };

  for (let i = 0; i < auditTrail.length; i++) {
    const x = auditTrail[i];
    const hasMap = Number.isFinite(x?.signingLatitude) && Number.isFinite(x?.signingLongitude);
    const rowCount = 6 + (x?.userAgent ? 1 : 0);
    const blockHeight = 21 + rowCount * 16 + 52 + (hasMap ? 122 : 0);

    if (yCur - blockHeight < startY + 10) {
      currentPage = newPage();
      yCur = currentPage.getHeight() - 40;
    }

    const isApprover = i >= signersCount;
    const roleLabel = isApprover ? `Approver ${i - signersCount + 1}` : `Signer ${i + 1}`;
    yCur = drawSignerHeader(currentPage, yCur, `${roleLabel}  \u00B7  ${x?.Name || '\u2014'}`);

    yCur = drawKV(currentPage, yCur, 'Name', x?.Name || '\u2014');
    yCur = drawKV(currentPage, yCur, 'Email', x?.Email || '\u2014');
    yCur = drawKV(currentPage, yCur, 'Viewed on', formatDateStr(x?.ViewedOn, DateFormat, timezone, Is12Hr) || '\u2014');
    yCur = drawKV(currentPage, yCur, 'Signed on', formatDateStr(x?.SignedOn, DateFormat, timezone, Is12Hr) || '\u2014');
    yCur = drawKV(currentPage, yCur, 'IP address', x?.ipAddress || '\u2014');

    // HEX_MAP_CERT: decimal + DMS + reported accuracy, as a commercial audit records
    let locText = '\u2014';
    if (x?.signingLocation) {
      let extra = '';
      try {
        if (Number.isFinite(x?.signingLatitude) && Number.isFinite(x?.signingLongitude)) {
          extra = '  (' + toDMS(x.signingLatitude, x.signingLongitude) + ')';
        }
      } catch (e) {}
      const _a = Number.isFinite(x?.locationAccuracy) ? x.locationAccuracy : x?.accuracy;
      const acc = Number.isFinite(_a) ? '  \u00B1' + Math.round(_a) + ' m' : '';
      locText = x.signingLocation + extra + acc;
    }
    yCur = drawKV(currentPage, yCur, 'Location at signing', locText);

    if (x?.userAgent) {
      yCur = drawKV(currentPage, yCur, 'Device', String(x.userAgent), { size: 8.2 });
    }

    // signature box on its own ruled row
    currentPage.drawText(sp('Signature'), {
      x: LEFT + 2, y: yCur + 1, size: 6.7, font: sansBold, color: labelGrey,
    });
    const sigH = 40;
    const sigW = 104;
    const sigY = yCur - sigH + 10;
    currentPage.drawRectangle({
      x: VAL, y: sigY, width: sigW, height: sigH,
      borderColor: hair, borderWidth: 0.8, color: rgb(1, 1, 1),
    });
    try {
      const embedPng = x.Signature ? await pdfDoc.embedPng(x.Signature) : nasign;
      if (embedPng) {
        currentPage.drawImage(embedPng, { x: VAL + 2, y: sigY + 2, width: sigW - 4, height: sigH - 4 });
      }
    } catch (e) {
      console.log('signature embed skipped:', e?.message || e);
    }
    const sigCaption = `${x?.Name || ''}  \u00B7  signed ${formatDateStr(x?.SignedOn, DateFormat, timezone, Is12Hr) || ''}`;
    currentPage.drawText(clampText(sans, sigCaption, 6.6, 210), {
      x: VAL, y: sigY - 10, size: 6.6, font: sans, color: labelGrey,
    });
    currentPage.drawLine({
      start: { x: LEFT, y: sigY - 15 }, end: { x: RIGHT, y: sigY - 15 },
      color: hair, thickness: 0.5,
    });
    yCur = sigY - 18;

    // location map, directly under the block
    if (hasMap) {
      try {
        const mapPng = await GenerateLocationMap(
          x.signingLatitude,
          x.signingLongitude,
          { w: 450, h: 336, zoom: 15 }   // 4:3-ish, drawn without squash
        );
        if (mapPng) {
          const mapImg = await pdfDoc.embedPng(mapPng);
          const mw = 150;
          const mh = 112;
          const mx = VAL;
          const my = yCur - mh - 4;
          currentPage.drawRectangle({
            x: mx - 2, y: my - 2, width: mw + 4, height: mh + 4,
            borderColor: hair, borderWidth: 0.8, color: rgb(1, 1, 1),
          });
          currentPage.drawImage(mapImg, { x: mx, y: my, width: mw, height: mh });
          currentPage.drawText('Signed from here  \u00B7  \u00A9 OpenStreetMap contributors', {
            x: mx, y: my - 9, size: 6.2, font: sans, color: labelGrey,
          });
          // side note: reported accuracy / source
          const noteX = mx + mw + 14;
          currentPage.drawText(sp('Location source'), {
            x: noteX, y: my + mh - 8, size: 6.7, font: sansBold, color: labelGrey,
          });
          currentPage.drawText('Browser geolocation', { x: noteX, y: my + mh - 19, size: 8.4, font: sans, color: ink });
          const _acc = Number.isFinite(x?.locationAccuracy) ? Math.round(x.locationAccuracy) : null;
          currentPage.drawText(sp('Reported accuracy'), {
            x: noteX, y: my + mh - 34, size: 6.7, font: sansBold, color: labelGrey,
          });
          currentPage.drawText(_acc != null ? `\u00B1${_acc} m` : '\u2014', {
            x: noteX, y: my + mh - 45, size: 8.4, font: sans, color: ink,
          });
          yCur = my - 14;
        }
      } catch (e) {
        console.log('map embed skipped:', e?.message || e);
      }
    }

    currentPage.drawLine({
      start: { x: LEFT, y: yCur }, end: { x: RIGHT, y: yCur },
      color: rgb(0.62, 0.65, 0.71), thickness: 0.8,
    });
    yCur -= 13;
  }

  // ---- declaration block, ALWAYS present, anchored at the foot of the last page ----
  try {
    const boxH = 66;
    const boxY = startY + 32;   // sits just above the footer rule
    // If the last signer block leaves no room, give the declaration its own page
    // rather than silently dropping it (HEX_DECL_ALWAYS).
    let lastPage = pdfDoc.getPages()[pdfDoc.getPages().length - 1];
    if (yCur < boxY + boxH + 2) {
      lastPage = pdfDoc.addPage();
      drawBorder(lastPage);
    }
    {
      lastPage.drawRectangle({
        x: LEFT, y: boxY, width: RIGHT - LEFT, height: boxH,
        borderColor: hair, borderWidth: 0.8, color: rgb(0.976, 0.980, 0.988),
      });
      lastPage.drawRectangle({ x: LEFT, y: boxY + boxH - 15, width: RIGHT - LEFT, height: 15, color: navy });
      lastPage.drawText(sp('Declaration and verification'), {
        x: LEFT + 8, y: boxY + boxH - 11, size: 7.4, font: sansBold, color: rgb(1, 1, 1),
      });
      const decl =
        'This certificate is generated automatically by the Rapid Lodgements eSign platform when the document ' +
        'reaches completion. ' +
        (documentHash ? 'The SHA-256 hash above identifies the final signed document. ' : '') +
        'Signer identity, time and IP address, plus device and location details where recorded, are captured at ' +
        'signing and cannot be altered afterwards.';
      lastPage.drawText(decl, {
        x: LEFT + 8, y: boxY + boxH - 27, size: 7.2, font: sans, color: ink,
        maxWidth: RIGHT - LEFT - 16, lineHeight: 10,
      });
      const verify = `Certificate ID ${docDetails.objectId}  \u00B7  verify at esign.rapidlodge.com.au`;
      lastPage.drawText(verify, {
        x: LEFT + 8, y: boxY + 8, size: 7.6, font: sansBold, color: navy,
      });
    }
  } catch (e) {
    console.log('declaration block skipped:', e?.message || e);
  }

  // ---- footer on every page ----
  const pages = pdfDoc.getPages();
  pages.forEach((pg, idx) => {
    const footY = startY + 12;
    pg.drawLine({
      start: { x: LEFT, y: footY + 9 }, end: { x: RIGHT, y: footY + 9 },
      color: hair, thickness: 0.5,
    });
    pg.drawText(
      'Generated by Rapid Lodgements eSign  \u00B7  esign.rapidlodge.com.au  \u00B7  ' +
      'this record is produced automatically when the document completes',
      { x: LEFT, y: footY, size: 6.4, font: sans, color: labelGrey }
    );
    const pn = `Page ${idx + 1} of ${pages.length}`;
    const pnW = sans.widthOfTextAtSize(pn, 6.8);
    pg.drawText(pn, { x: RIGHT - pnW, y: footY, size: 6.8, font: sans, color: labelGrey });
  });

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}
