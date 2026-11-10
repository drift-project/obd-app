# DRIFThing OBD (aplikacja na telefon)

Strona WWW, która w Chrome łączy się z adapterem OBD2 ELM327 po Bluetooth, pokazuje dane z auta na żywo (obroty, prędkość, gaz, pedał, temperatury) i zapisuje je do CSV w tym samym formacie co logger na Raspberry (`obd_main.py` w repo `raspberry-unicore`). Razem z danymi auta zapisuje czujniki telefonu: akcelerometr, żyroskop, magnetometr, orientację i GPS.

To wersja na pierwszy test: bez instalacji, bez budowania, bez wysyłania danych na serwer.

## Wymagania

- Telefon z Androidem i Chrome 137 lub nowszym. Działa też Chrome albo Edge na laptopie.
- Adapter ELM327 z klasycznym Bluetooth, wcześniej **sparowany w ustawieniach Bluetooth systemu** (PIN zwykle `1234` albo `0000`). Adapter bierze zasilanie z gniazda OBD, więc parować trzeba go wpiętego w auto (dowolne).
- Do starszych aut (przed CAN, na przykład BMW E39) adapter musi obsługiwać linię K, czyli protokoły ISO 9141-2 i KWP2000. Część najtańszych klonów, zwłaszcza podpisanych "v2.1", obsługuje tylko CAN i z takim autem się nie połączy.
- iPhone nie zadziała: przeglądarki na iOS nie mają dostępu do portów szeregowych.

## Adres

Aplikacja jest opublikowana na GitHub Pages z gałęzi `main` tego repo:

**https://drift-project.github.io/obd-app/**

Zmiana wypchnięta na `main` jest pod tym adresem zwykle po około minucie.

## Uruchomienie na telefonie

1. Otwórz adres w Chrome na telefonie.
2. Z menu Chrome wybierz "Dodaj do ekranu głównego".
3. Zamknij Chrome i otwórz aplikację z ikony.

Po pierwszym otwarciu aplikacja działa także bez internetu: pliki zostają w pamięci telefonu (service worker), więc w aucie wystarczy uruchomić ją z ikony.

Gdy internet jest, aplikacja przy każdym uruchomieniu pyta serwer o aktualne pliki. Żeby pobrać nową wersję, przeciągnij ekran w dół (odświeżenie) albo zamknij aplikację na liście ostatnich i otwórz ją ponownie. Numer wersji jest w stopce strony.

### Lista adapterów jest pusta

Jeśli po dotknięciu **Connect adapter** Chrome pisze "Nie znaleziono zgodnych urządzeń", a adapter jest sparowany i działa w innej aplikacji (na przykład Car Scanner), to Chrome nie ma dostępu do Bluetooth:

1. Ustawienia telefonu, Aplikacje, Chrome, Uprawnienia: ustaw **Urządzenia w pobliżu** na "Zezwól".
2. Na ekranie aplikacji Chrome dotknij **Wymuś zatrzymanie**. Chrome układa listę urządzeń Bluetooth raz na uruchomienie, więc bez tego lista zostaje pusta.
3. Rozłącz inną aplikację OBD (adapter obsługuje jedno połączenie naraz), otwórz DRIFThing OBD i spróbuj ponownie.

Od wersji 0.2.2 aplikacja prosi na Androidzie tylko o porty Bluetooth i wtedy Chrome sam pyta o to uprawnienie. Chrome pokazuje wyłącznie urządzenia sparowane w ustawieniach Bluetooth telefonu, dla których system zapamiętał usługę portu szeregowego.

## Uruchomienie na laptopie

Ten sam adres działa w Chrome i Edge na laptopie. Do pracy nad kodem aplikację uruchamia się lokalnie:

```bash
npm start
```

Otwórz `http://localhost:8093`. Przycisk **Demo** pokazuje aplikację na symulowanym aucie. **Connect adapter** otwiera listę portów (sparowany adapter jest na niej jako urządzenie Bluetooth albo port COM).

Demo ma trzy warianty, wybierane dopiskiem w adresie strony (lokalnie i pod adresem publicznym):

- bez dopisku: auto z CAN, około 20 wierszy na sekundę,
- `?car=kline`: stare auto z linią K (jak E39), jedna wartość na zapytanie, około 2 wierszy na sekundę,
- `?car=silent`: auto, które nie odpowiada; widać komunikat na ekranie i kolejne próby w dzienniku.

### Lokalna wersja na telefonie

Zmiany, których nie ma jeszcze na `main`, da się sprawdzić na telefonie przez USB. Chrome udostępnia porty szeregowe tylko stronom z HTTPS albo z `localhost`, więc telefon musi widzieć lokalny serwer jako swój `localhost`:

1. Włącz w telefonie debugowanie USB i podłącz go do laptopa.
2. Na laptopie uruchom `npm start`, a w drugim terminalu:

   ```bash
   adb reverse tcp:8093 tcp:8093
   ```

3. W Chrome na telefonie otwórz `http://localhost:8093`.

## Test w aucie z samym telefonem

W domu, zanim pojedziesz:

1. Otwórz aplikację na telefonie i dodaj ją do ekranu głównego (rozdział wyżej). Sprawdź, że otwiera się z ikony także w trybie samolotowym.
2. Wepnij adapter w dowolne auto, włącz zapłon i sparuj adapter w ustawieniach Bluetooth telefonu.
3. Zrób próbę na tym aucie: **Connect adapter**, wybierz adapter z listy, poczekaj na dane. Przy pierwszym razie Chrome poprosi o zgodę na urządzenia w pobliżu. Jeśli to działa, telefon, przeglądarka i adapter są sprawdzone, a w aucie docelowym zostaje do sprawdzenia tylko ono samo.

Przy aucie:

1. Wepnij adapter (kontrolka ma świecić), włącz zapłon, najlepiej odpal silnik.
2. Otwórz aplikację i dotknij **Connect adapter**. Pod nagłówkiem widać, co się dzieje: reset adaptera, szukanie protokołu, kolejne próby. W starym aucie pierwsze połączenie może trwać kilkanaście sekund.
3. Gdy dane lecą, zapisują się same. Na koniec **Save** albo **Share**.
4. Gdy coś nie działa, na górze pojawia się komunikat z przyczyną, a aplikacja próbuje dalej sama. Rozwiń **Diagnostic log** i wyślij go przyciskiem **Share** (albo **Copy** i wklej do wiadomości). W środku jest cała rozmowa z adapterem, wersja adaptera, napięcie i lista prób, więc da się z tego ustalić przyczynę bez laptopa przy aucie.

Dziennik diagnostyczny przetrwa zamknięcie strony, więc można go wysłać także po powrocie.

## Stare auta z linią K (na przykład BMW E39)

E39 nie ma CAN na gnieździe diagnostycznym. Według list zgodności skanerów benzynowe wersje rozmawiają protokołem ISO 9141-2, a 530d protokołem KWP2000 (fast init). Dla aplikacji oznacza to:

- **Wolniejszy odczyt.** Jedno zapytanie zwraca jedną wartość. W teście na E39 (10.11.2026) trwało około 240 ms, czyli auto daje około 4 wartości na sekundę: obroty, prędkość i gaz po około 1,2 Hz, a temperatury co około 6 s. To granica protokołu ISO 9141-2, nie aplikacji. Czas zapytania pokazuje pole "One request" w **Adapter details**.
- **Wartości w wierszu są czytane po kolei.** Znacznik czasu wiersza to środek cyklu, więc pierwsza wartość (obroty) jest starsza o mniej więcej jedno zapytanie, a ostatnia młodsza. Na CAN szybkie wartości zwykle przychodzą jednym zapytaniem i różnicy nie ma.
- **Szukanie protokołu z zapasem.** Aplikacja najpierw zleca adapterowi automatyczne szukanie, a gdy ono zawiedzie (zdarza się to na autach z ISO 9141-2), sama próbuje kolejno ISO 9141-2, KWP fast init i KWP z inicjalizacją 5 baud. Protokół, który zadziałał, jest zapamiętywany i przy następnym połączeniu idzie pierwszy.
- **Mniej sygnałów.** Auto zgłasza, co obsługuje. Pedał gazu (PID 49) i ciśnienie w kolektorze w takim aucie zwykle będą oznaczone "n/a".
- **Gniazdo.** Auta po liftingu (od około połowy 2000 roku) mają 16-pinowe gniazdo OBD w kabinie, pod kierownicą po stronie drzwi, za klapką. Starsze mają okrągłe gniazdo 20-pin pod maską i mogą wymagać przejściówki 20 na 16 pin.

Jeśli auto nie odpowiada na żadnym protokole przy włączonym zapłonie, zostają dwie przyczyny, których aplikacja nie obejdzie: adapter bez działającej linii K albo sterownik silnika bez standardowego OBD2 (wtedy dane da się czytać tylko protokołem BMW, kablem INPA).

## Użycie na co dzień

1. Wepnij adapter w gniazdo OBD2 i włącz zapłon.
2. Otwórz aplikację i dotknij **Connect adapter**, a potem wybierz adapter z listy. Następnym razem aplikacja połączy się z nim od razu. **Choose another adapter** wybiera inny.
3. Dane zapisują się same od chwili połączenia, razem z czujnikami telefonu. **Save** zapisuje log w pobranych: sam plik `obd_data_RRRRMMDD_GGMMSS.csv`, a gdy są dane z telefonu, archiwum `drifthing_log_RRRRMMDD_GGMMSS.zip` ze wszystkimi plikami. **Share** wysyła pliki CSV dalej (Dysk, Messenger), **Clear** (dwa dotknięcia) kasuje log.

Log jest trzymany w pamięci przeglądarki, dopóki go nie skasujesz, więc przetrwa zamknięcie strony. Przy nagłym zamknięciu może przepaść około ostatniej sekundy.

Strona musi być na wierzchu, z włączonym ekranem (aplikacja sama blokuje wygaszanie). W tle Chrome wstrzymuje strony i zapis staje.

## Akumulator

Adapter mierzy napięcie na gnieździe diagnostycznym, czyli napięcie akumulatora. Aplikacja zapisuje je w kolumnie `battery_v` (przy zgaszonym silniku w każdym wierszu, przy pracującym co 5 sekund) i w sekcji **Battery** pokazuje:

- **Charge**: szacunek naładowania w procentach i w amperogodzinach, liczony z napięcia przy zgaszonym silniku.
- **Engine off**: napięcie przed uruchomieniem silnika.
- **While starting**: najniższe napięcie złapane podczas kręcenia rozrusznikiem. Odczyt jest mniej więcej raz na sekundę, więc najgłębszy spadek może umknąć.
- **Engine running**: napięcie ładowania z oceną. 13,6 do 14,9 V to normalne ładowanie, 13,0 do 13,6 V słabe, poniżej 13,0 V alternator nie ładuje, powyżej 14,9 V regulator podaje za dużo.

Żeby zobaczyć naładowanie, połącz adapter przy włączonym zapłonie, zanim odpalisz silnik, najlepiej po kilku godzinach postoju. Aplikacja zapamiętuje napięcie sprzed pierwszego rozruchu i nie zastępuje go późniejszymi odczytami, bo po jeździe akumulator pokazuje zawyżone napięcie. Gdy silnik już pracuje w chwili połączenia, naładowania nie da się ocenić.

| Naładowanie | Zwykły akumulator | AGM |
|---|---|---|
| 100% | 12,60 V | 12,84 V |
| 75% | 12,40 V | 12,54 V |
| 50% | 12,20 V | 12,24 V |
| 25% | 12,00 V | 11,94 V |
| 0% | 11,80 V | 11,64 V |

Wartości dla zwykłego akumulatora pochodzą z Battery Council International, dla AGM z danych firmy Trojan. Między wierszami aplikacja liczy proporcjonalnie.

To szacunek, nie pomiar:

- Jedna dziesiąta wolta to około 12% naładowania, a woltomierz taniego adaptera potrafi się mylić o jedną albo dwie dziesiąte. Warto raz porównać wskazanie z multimetrem na klemach i wpisać różnicę w polu **Voltmeter correction**.
- Włączony zapłon obciąża akumulator, więc napięcie jest nieco niższe niż na prawdziwym postoju.
- Akumulator ładowany w ostatnich godzinach pokazuje więcej, niż ma. Wiarygodny odczyt wymaga co najmniej 4 godzin postoju.
- Napięcie nie mówi nic o zużyciu akumulatora: stary może pokazywać 100% i mieć ułamek pojemności. Trochę mówi o tym spadek napięcia przy rozruchu.

Pojemność (domyślnie 100 Ah) i typ akumulatora ustawia się w tej samej sekcji; ustawienia zostają w telefonie.

## Czujniki telefonu

Razem z danymi auta aplikacja zapisuje czujniki telefonu. Zapis startuje sam po **Connect adapter**. Bez adaptera uruchamia go **Record the phone sensors without the car**. W trybie Demo czujniki nie są zapisywane.

| Plik | Co zawiera | Częstotliwość |
|---|---|---|
| `phone_accelerometer` | przyspieszenie z grawitacją, m/s² | 60 Hz |
| `phone_linear_acceleration` | przyspieszenie bez grawitacji, m/s² | 60 Hz |
| `phone_gyroscope` | prędkość obrotu, rad/s | 60 Hz |
| `phone_magnetometer` | pole magnetyczne, µT | 10 Hz |
| `phone_orientation` | ustawienie telefonu względem Ziemi (z kompasem), kwaternion | 60 Hz |
| `phone_relative_orientation` | ustawienie telefonu bez kompasu, kwaternion | 60 Hz |
| `phone_gps` | pozycja, wysokość, dokładność, kurs i prędkość | zwykle 1 Hz |
| `phone_drift` | to, co pokazywał widok Drift: kierunek nadwozia, kurs, kąt driftu | 10 Hz |

- **Częstotliwość.** 60 Hz dla czujników ruchu i 10 Hz dla magnetometru to granice Chrome dla stron WWW, nie samych czujników. Więcej da tylko aplikacja natywna.
- **Magnetometr** jest w Chrome wyłączony i zwykle nie warto go włączać: kompas i tak jest użyty w `phone_orientation`. Jak go włączyć, opisuje rozdział niżej.
- **GPS** wymaga zgody na lokalizację przy pierwszym uruchomieniu i włączonej lokalizacji w telefonie.
- **Dwie prędkości.** Na ekranie obok prędkości z auta (koła) jest prędkość z GPS (względem ziemi). Różnica między nimi to poślizg kół.
- **Osie** są osiami telefonu: x w prawo ekranu, y w górę ekranu, z od ekranu w stronę patrzącego. Telefon musi być sztywno zamocowany, inaczej dane ruchu opisują telefon, a nie auto.
- **Czas.** Każdy plik ma w pierwszej kolumnie `timestamp_ms` z jednego zegara: zegar telefonu jest odczytywany raz na starcie zapisu, a dalej liczy zegar monotoniczny, więc dane auta i telefonu da się zestawić. `phone_gps` ma dodatkowo `fix_ms`, czyli czas pomiaru podany przez odbiornik.

Stan każdego czujnika (częstotliwość, liczba próbek albo powód braku) pokazuje sekcja **Phone sensors**. Do loga dołączany jest plik `log_info` z opisem plików i kolumn.

### Magnetometr

Surowy magnetometr Chrome trzyma za funkcją `GenericSensorExtraClasses`, która jest domyślnie wyłączona. Do około wersji 130 miała przełącznik `chrome://flags/#enable-generic-sensor-extra-classes`; w nowszych wersjach (sprawdzone w źródłach 140, 150 i 156) tego przełącznika już nie ma i zostaje wiersz poleceń ustawiany z komputera:

1. W Chrome na telefonie otwórz `chrome://flags/#enable-command-line-on-non-rooted-devices`, wybierz "Enabled" i uruchom Chrome ponownie.
2. Podłącz telefon kablem (debugowanie USB włączone) i na komputerze wykonaj:

   ```bash
   adb shell "echo '_ --enable-features=GenericSensorExtraClasses' > /data/local/tmp/chrome-command-line"
   ```

3. W ustawieniach telefonu wymuś zatrzymanie Chrome i otwórz aplikację ponownie. W sekcji **Phone sensors** przy magnetometrze powinno pojawić się "10 Hz".

Żeby to cofnąć, usuń plik: `adb shell rm /data/local/tmp/chrome-command-line`. Ta procedura wynika ze źródeł Chrome i nie była sprawdzana na telefonie. Sama flaga `enable-experimental-web-platform-features` nie wystarcza: pokazuje stronie klasę `Magnetometer`, ale czujnik dalej nie startuje.

## Widok Drift

Przełącznik **Car / Drift** pod nagłówkiem zmienia licznik na mapę, wzorowaną na trybie analizy w `drifthing-ui`: ślad przejazdu, auto obrócone tak, jak stoi nadwozie, strzałka kierunku jazdy i odczyty na żywo.

- **Drift angle**: kąt między kierunkiem nadwozia a kierunkiem jazdy, liczony jak w `middle-math` (kierunek nadwozia minus kurs, od -180 do 180 stopni). Litera obok mówi, w którą stronę od kierunku jazdy wskazuje nos: **R** w prawo, **L** w lewo.
- **GPS** i **Car**: prędkość względem ziemi i prędkość kół z auta.
- **Turn**: prędkość obrotu auta w stopniach na sekundę, dodatnia w prawo.

Skąd bierze się kąt:

- **Kierunek nadwozia** pochodzi z orientacji telefonu (żyroskop i akcelerometr). Telefon wie tylko, o ile się obrócił, więc punkt odniesienia bierze z GPS: gdy auto jedzie prosto przez dwie sekundy z prędkością powyżej około 20 km/h, kierunek nadwozia jest ustawiany na kurs z GPS. Ta kalibracja powtarza się sama na każdej prostej i usuwa pełzanie żyroskopu. Mocowanie telefonu może być dowolne, byle sztywne.
- **Poślizg na wprost** nie jest brany za jazdę prosto: duża poprawka krótko po poprzedniej jest odrzucana, a gdy auto podaje prędkość kół, kalibracja czeka, aż zgodzi się ona z prędkością z GPS.
- **Kierunek jazdy** podaje GPS, ale tylko raz na sekundę. Między pomiarami prędkość auta jest prowadzona dalej z akcelerometru. Ustawienie osi telefonu względem północy i opóźnienie pomiarów GPS aplikacja wyznacza sama z danych, po kilku zmianach prędkości albo kierunku. Do tego czasu kurs między pomiarami jest zgadywany i w ciasnych manewrach kąt może być chwilowo błędny o kilkanaście stopni.
- **Ślad** ma dzięki temu punkty także między pomiarami GPS, więc łuki są gładkie.

W symulacji z idealnymi czujnikami błąd kąta jest poniżej stopnia, z zaszumionymi średnio 1,5 stopnia i chwilowo do kilku stopni. Na prawdziwym aucie nie było to jeszcze mierzone. To nie zastąpi urządzenia z dwiema antenami RTK: jazda tyłem, długie obracanie w miejscu bez prostych i luźny uchwyt telefonu dają błędne wskazania.

Mapa pobiera kafelki z serwera OpenStreetMap, więc otwarty widok Drift wysyła tam przybliżone położenie (numer kafelka). Sam ślad i dane nie są nigdzie wysyłane. Bez internetu mapa jest pusta, a ślad i auto są rysowane na siatce. Przyciski **+** i **-** zmieniają powiększenie.

Tryb **Demo** pokazuje ten widok na wymyślonym przejeździe po ósemce (na starym pasie lotniska Tempelhof w Berlinie).

To, co widok pokazywał, zapisuje się dziesięć razy na sekundę w pliku `phone_drift` (kierunek nadwozia, kurs, kąt driftu, prędkość obrotu, prędkość, pozycja i stan kalibracji), żeby dało się to sprawdzić po przejeździe.

## Dane

Kolumny CSV: `timestamp_ms, rpm, speed_kmh, throttle_pct, pedal_pct, engine_load_pct, coolant_c, intake_air_c, maf_gs, map_kpa, oil_c, ambient_c, catalyst_c, battery_v`. Pierwsze dziesięć jest takie samo jak w loggerze na Raspberry. Ostatnia to napięcie akumulatora mierzone przez adapter. Pusta komórka oznacza, że auto nie obsługuje danej wartości albo nie była czytana w tym cyklu (wartości silnika i temperatury są czytane kolejno, jedna na sekundę).

Temperatury oleju (`oil_c`), powietrza na zewnątrz (`ambient_c`) i katalizatora (`catalyst_c`) są w standardzie OBD2, ale zgłaszają je głównie nowsze auta. Kafelek na ekranie pojawia się tylko wtedy, gdy auto daną wartość ma.

`timestamp_ms` to zegar telefonu w środku zapytania. Telefon synchronizuje zegar z siecią, więc dane da się zestawić z GNSS z urządzenia.

Aplikacja pyta auto, które wartości obsługuje, i czyta tylko te. Pełna lista wartości zgłoszonych przez auto (także tych, których aplikacja nie czyta) jest w dzienniku diagnostycznym, w wierszu "the car reports N mode 01 PIDs". Listy zgłoszone przez różne sterowniki (silnik, skrzynia) są łączone. Na CAN szybkie dane idą jednym zapytaniem, o ile auto na to pozwala; na linii K zawsze po jednej wartości.

## Czego jeszcze nie ma

- Odczyt z auta przeszedł pierwszy test (10.11.2026: BMW E39, adapter Vgate Scan, telefon z Androidem). Zapis czujników telefonu był sprawdzany tylko w Chrome na komputerze, z podstawionymi czujnikami i GPS; na prawdziwym telefonie jeszcze nie.
- Dane nie są nigdzie wysyłane. Żeby trafiały do projektu, trzeba je dopiąć do brokera MQTT (przeglądarka potrzebuje do tego MQTT po WebSocket) albo wgrywać CSV.
- Widok Drift i wyliczanie kąta driftu były sprawdzane tylko na symulowanym przejeździe, w testach i w Chrome na komputerze.
- Ocena akumulatora była sprawdzana na symulowanym rozruchu. Na aucie widać było dotąd tylko to, że adapter podaje napięcie (13,9 V przy pracującym silniku).
- Hamulec i kąt skrętu kierownicy nie są standardowymi wartościami OBD2. Wymagają czytania surowych ramek konkretnego modelu auta, a w E39 protokołu BMW.

## Testy

```bash
npm test
```

Testy (Node 22, bez zależności) sprawdzają dekodowanie wartości, parsowanie odpowiedzi adaptera, sesję na symulatorze (CAN, linia K, klon odrzucający komendy, auto bez odpowiedzi, zawieszone szukanie protokołu), pętlę odczytu z ponownym łączeniem, dziennik diagnostyczny, transport Web Serial na podstawionym porcie, eksport CSV, listę plików do pracy bez serwera, service worker na podstawionym serwerze (start bez sieci, pobranie nowej wersji, wolny serwer), wybór portu adaptera, zapis czujników telefonu na podstawionych czujnikach i GPS, format próbek, archiwum ZIP (odczytywane niezależnym kodem), arytmetykę mapy, kąt driftu na symulowanych przejazdach (dowolne mocowanie telefonu, opóźniony GPS, szum czujników, przerwa w danych) oraz ocenę akumulatora (tabele napięć, rozruch, ładowanie).

## Pliki

- `src/pids.js`, `src/elm327.js`, `src/poller.js`: protokół i pętla odczytu (przeniesione z loggera na Raspberry).
- `src/transports.js`: połączenie przez Web Serial. `src/simulator.js`: symulowany adapter i auto.
- `src/trace.js`: dziennik diagnostyczny rozmowy z adapterem.
- `src/battery.js`: naładowanie akumulatora z napięcia i ocena ładowania.
- `src/sensors.js`: czujniki ruchu i GPS telefonu. `src/samples.js`: ich próbki i zapis do CSV.
- `src/drift.js`: kierunek nadwozia, kurs i kąt driftu. `src/geo.js`, `src/map.js`: mapa. `src/demo-drive.js`: przejazd dla trybu Demo.
- `src/app.js`, `index.html`, `styles.css`: ekran. `src/storage.js`, `src/csv.js`, `src/zip.js`: log i eksport.
- `sw.js`, `manifest.webmanifest`: praca bez serwera, pobieranie nowej wersji i ikona na ekranie głównym. Nowy plik aplikacji trzeba dopisać do listy w `sw.js` (pilnuje tego test).
- `.nojekyll`: GitHub Pages ma podawać pliki bez przetwarzania.
- `tools/make_icons.py`: generuje ikony PNG (wymaga Pillow).
