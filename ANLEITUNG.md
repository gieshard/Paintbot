# PaintBot Steuerpult – Einrichtung und Bedienung

Die App ist eine Webseite, die sich per Bluetooth direkt mit dem Roboter verbindet.
Sie läuft am PC und am Handy. Damit das Handy Bluetooth im Browser freigibt, muss die
Seite über eine **https-Adresse** kommen – dafür wird sie einmalig kostenlos auf
GitHub Pages abgelegt.

## Voraussetzungen

- Firmware **V13** auf dem Roboter (mit `AppControl.ino`, Menü 8). Ältere Firmware
  versteht die Tasten der App, aber keine Fahrbefehle und keine Zeichnungen.
- Browser:

  | Gerät | Browser |
  |---|---|
  | PC (Windows 10/11, macOS) | Chrome oder Edge |
  | Android | Chrome |
  | iPhone / iPad | App **Bluefy** aus dem App Store (Safari und Chrome auf dem iPhone können kein Bluetooth) |

- Der Roboter nimmt **nur eine Bluetooth-Verbindung** gleichzeitig an. Vorher die
  Bluefruit-App trennen bzw. schließen.

## Einmalig: auf GitHub Pages veröffentlichen

1. Auf <https://github.com/signup> ein kostenloses Konto anlegen (falls noch keins da ist).
2. Oben rechts **+ → New repository**. Name: `paintbot`, Sichtbarkeit **Public**
   (GitHub Pages ist im kostenlosen Konto nur für öffentliche Repositories frei).
   **Create repository**.
3. Auf der neuen Seite **uploading an existing file** anklicken und alle Dateien
   aus diesem Ordner hineinziehen:
   `index.html`, `app.js`, `manifest.webmanifest`, `sw.js`, `icon.svg`,
   `icon-192.png`, `icon-512.png` (`README.md` und diese Anleitung können mit). **Commit changes**.
4. **Settings → Pages**. Unter *Build and deployment*: Source **Deploy from a
   branch**, Branch **main**, Ordner **/ (root)**, **Save**.
5. Nach ein bis zwei Minuten steht dort die Adresse, z. B.
   `https://DEINNAME.github.io/paintbot/`. Diese Adresse am PC und am Handy öffnen.

Die Seite ist öffentlich erreichbar, enthält aber keine Daten. Steuern kann den
Roboter nur, wer in Bluetooth-Reichweite ist und die Verbindung im Browser bestätigt.

**Als App aufs Handy:** Android-Chrome → Menü ⋮ → *App installieren* bzw. *Zum
Startbildschirm hinzufügen*. In Bluefy die Adresse als Lesezeichen speichern.

**Neue Version:** Im Repository erneut *Add file → Upload files*, die geänderten
Dateien hineinziehen, *Commit*. Nach kurzer Zeit lädt die App die neue Fassung.

## Bedienung

1. Roboter einschalten, oben **Verbinden** → in der Liste den Roboter wählen.
   Ohne Roboter: **Demo** (simuliert alles, nichts wird wirklich gefahren).
2. **Tasten** – genau wie die Bluefruit-App, inklusive langem Druck.
   Rechts steht, was jede Taste im aktuellen Menü tut. Darunter jedes Menü direkt
   anwählen. Am PC: Pfeiltasten, 1–4, **Leertaste = Stop**.
3. **Fahren** – nur in **Menü 8 (App-Steuerung)**. Die App bietet den Wechsel an.
   Danach **Fahren freigeben** und Strecken (cm) oder Drehungen (Grad) senden.
4. **Zeichnen**
   - Blattformat wählen, mit Maus oder Finger zeichnen: Freihand, Linienzug
     (antippen, „Linienzug fertig“ oder Doppelklick), Rechteck, Kreis, Vorlagen.
   - **Pfad-Vorschau**: blau = Linie mit Stift unten, orange gestrichelt =
     Leerfahrt mit Stift oben, Punkte = Drehungen. *Abspielen* zeigt den
     Ablauf im Zeitraffer, der Schieberegler springt an jede Stelle. Dauer,
     Linienlänge und Leerfahrten stehen daneben.
   - **An Roboter senden**: überträgt die Zeichnung, fragt dann nach. Blatt quer
     legen, Roboter mit dem Stift auf die Blattmitte, Blick nach rechts (lange
     Kante), *Freigeben und zeichnen*. Während er zeichnet, zeigt die App seine
     Position live (grüner Kreis).
   - Die Zeichnung bleibt im Browser gespeichert.
5. **Kalibrieren** – 90° drehen lassen, echten Winkel eintragen → *Spurweite
   übernehmen*. Genauso für 100 cm Strecke → *Raddurchmesser übernehmen*.
   Gilt bis zum Neustart; die Zeilen für `global.h` stehen daneben.
6. **Stop** (oben rechts, Leertaste) hält immer sofort an.

## Wenn etwas nicht geht

- **Roboter erscheint nicht in der Liste:** Bluefruit-App noch verbunden? Bluetooth
  am PC/Handy an? Auf Android braucht Chrome die Berechtigung *Geräte in der Nähe*.
- **„Dieser Browser kann kein Bluetooth“:** anderen Browser nehmen (siehe Tabelle)
  oder die Seite wurde nicht über https geöffnet.
- **Fahrbefehle werden abgelehnt:** Statusleiste prüfen – Menü 8 und *Fahren: frei*
  müssen stehen. Ein Menüwechsel sperrt automatisch.
- **Im Protokoll fehlen Zeilen:** Haken *Maschinenzeilen* zeigt auch die
  Statusmeldungen der Firmware (`@STAT`, `@PROG` …).
