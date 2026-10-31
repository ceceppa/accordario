# Accordario

Clone locale di Chordify/Chordu: incolli un link YouTube, il server trova
battute e accordi e li mostra in una griglia sincronizzata col video.
Opzionalmente separa le tracce (voce, batteria, basso, chitarra, piano, altro)
per esercitarsi solo con le tastiere o suonarci sopra.

## Avvio

```bash
./start.sh
```

Poi apri <http://127.0.0.1:8765>.

Il primo avvio crea l'ambiente Python in `server/.venv` (circa 850 MB, per
PyTorch). Gli avvii successivi sono immediati; a ogni avvio `yt-dlp` viene
aggiornato, perché YouTube cambia spesso.

Requisiti: macOS/Linux, `ffmpeg` (`brew install ffmpeg`), Python 3.10–3.12,
Node.js (yt-dlp lo usa per decifrare i link di YouTube).

## Uso

- **Clic** su una battuta: il video riparte da lì.
- **Trascina** sulla griglia (o `Shift`+clic): seleziona un tratto e lo ripete
  in loop. I pulsanti **A**/**B** fissano inizio/fine sulla battuta corrente.
- **Tasto destro** su un accordo: lo correggi (vale fino al prossimo cambio).
  Puoi scrivere sia `F#m` sia `Fa#m`.
- **Capo / Trasponi**: il capo cambia le forme per la chitarra (con i diagrammi
  da piano viene ignorato), trasponi cambia la tonalità.
- **Velocità**: con il video YouTube sono disponibili 0.5×, 0.75×, 1×, 1.25×;
  con le tracce separate qualsiasi velocità, sempre senza cambiare intonazione.
- Scorciatoie: `Spazio` play/pausa, `←`/`→` misura precedente/successiva,
  `L` loop, `Esc` annulla selezione, `-`/`+` velocità.

### Più brani in coda

Il pulsante **Più brani** (o incollare più link nel campo in alto) apre una
finestra dove incolli una lista di link, uno per riga, o una playlist intera
(fino a 200 video). Il server scarica 3 brani alla volta in parallelo e li
analizza uno dopo l'altro; i brani pronti compaiono in libreria con l'etichetta
**nuovo**. Nel frattempo puoi continuare a suonare.

- La sezione **In elaborazione** nella barra laterale mostra lo stato di ogni
  brano; con × lo togli dalla coda, con ↻ riprovi quelli andati in errore.
- Se apri un brano ancora in coda, passa davanti agli altri.
- Spunta **Separa anche le tracce** per avere i brani pronti anche con le
  tracce separate (circa 2 minuti in più a brano). Vale anche per brani già
  in libreria: in quel caso fa solo la separazione.
- La coda resta salvata: se chiudi o ricarichi la pagina riprende da dove era.
  Il lavoro avviene sul server, quindi continua anche a pagina chiusa (finché
  il server è acceso).

### Libreria

I brani analizzati restano nel `localStorage` del browser, con accordi,
correzioni e impostazioni (capo, loop, velocità, mix delle tracce). Dalla barra
laterale puoi cercarli (titolo, artista, tonalità), riaprirli ed eliminarli.
**Esporta/Importa** salva o ricarica un backup JSON: utile perché il
`localStorage` è legato al browser.

Eliminando un brano dalla libreria si cancellano anche l'audio e le tracce
salvati in `server/cache/`.

### Tracce separate

Il pulsante **Separa le tracce** usa Demucs (`htdemucs_6s`): circa 2 minuti per
un brano di 4 minuti su un Mac con Apple Silicon, ~35 MB su disco per brano.
Poi attivi **Ascolta dalle tracce separate**: il video resta visibile ma muto, e
l'audio arriva dalle tracce, che puoi mettere in solo (S), mute (M) o regolare.

Preset utili per le tastiere:
- **Solo tastiere** = Piano + Altro
- **Senza tastiere** = tutto tranne Piano e Altro, per suonarci sopra

Limite noto: nessun modello open separa piano, synth e organo tra loro. Il
pianoforte finisce nella traccia *Piano*; synth, organi e pad di solito in
*Altro* (insieme ad archi e fiati).

## Come riconosce gli accordi

Server Python (FastAPI) con le reti neurali di [madmom](https://github.com/CPJKU/madmom):

1. `yt-dlp` scarica solo l'audio.
2. Una rete ricorrente trova battute e primi tempi (3/4 o 4/4).
3. Una rete convoluzionale + CRF calcola, per ogni frazione di secondo, la
   probabilità di ciascun accordo maggiore/minore.
4. Le probabilità vengono sommate per battuta e decodificate con un Viterbi a
   livello di battuta: i cambi di accordo preferiscono il primo tempo della
   misura e gli accordi della tonalità rilevata hanno un piccolo vantaggio.
   Questo elimina gli accordi spuri di un solo battito.

Il vocabolario è maggiore/minore (come la versione base di Chordify): le
settime e gli altri accordi si aggiungono a mano con il tasto destro. Le
intro con solo basso o batteria e i passaggi molto arrangiati restano i casi
più difficili.

Un brano di 4 minuti si analizza in circa 30 secondi. Il risultato è salvato in
`server/cache/<id>/analysis.json`, quindi riaprire un brano è immediato.

## Struttura

```
start.sh              setup + avvio
server/app.py         API, coda dei job (download paralleli, analisi in fila)
server/analysis.py    download, battute, accordi, tonalità
server/stems.py       separazione tracce (Demucs)
web/index.html        interfaccia
web/js/main.js        logica dell'app
web/js/transport.js   orologio unico: player YouTube o audio delle tracce
web/js/grid.js        griglia degli accordi, selezione, loop
web/js/chords.js      parsing, trasposizione, notazione, diteggiature
web/js/diagrams.js    diagrammi SVG chitarra/piano
web/js/library.js     libreria in localStorage
web/js/queue.js       coda di analisi (più brani / playlist)
```

## Note

- Se il proprietario non permette di incorporare il video, il player viene
  nascosto e al suo posto suona l'audio scaricato, con un link per guardarlo su
  YouTube. Accordi, loop, velocità e tracce funzionano come sempre. L'app se lo
  ricorda (lo capisce già durante l'analisi, o al primo errore del player) e
  le volte successive non prova nemmeno a caricare il video.
- yt-dlp ha deprecato Python 3.10. Se un giorno smette di funzionare, ricrea
  l'ambiente con Python 3.11 o 3.12: `rm -rf server/.venv && ./start.sh`.
- Sono esclusi le dirette e i video oltre i 30 minuti.
