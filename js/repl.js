class ReplJS{
    constructor(){
        this.PORT = undefined;      // Reference to serial port
        this.READER = undefined;    // Reference to serial port reader, only one can be locked at a time
        this.WRITER = undefined;    // Reference to serial port writer, only one can be locked at a time

        this.TEXT_ENCODER = new TextEncoder();  // Used to write text to MicroPython
        this.TEXT_DECODER = new TextDecoder();  // Used to read text from MicroPython

        this.USB_VENDOR_ID = 11914;     // For filtering ports during auto or manual selection
        this.USB_PRODUCT_ID = 5;        // For filtering ports during auto or manual selection
        this.USB_PRODUCT_MAC_ID = 10;   // For filtering ports during auto or manual selection

        // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L444 need to only send 256 bytes each time
        this.THUMBY_SEND_BLOCK_SIZE = 255;  // How many bytes to send to Thumby at a time when uploading a file to it

        // Set true so most terminal output gets passed to javascript terminal
        this.DEBUG_CONSOLE_ON = false;

        this.COLLECT_RAW_DATA = false;
        this.COLLECTED_RAW_DATA = [];

        this.HAS_MICROPYTHON = false;

        // Used to stop interaction with the RP2040
        this.BUSY = false;
        this.RUN_BUSY = false; //used to distinguish that we are in the RUN of a user program vs other BUSY.

        this.RUN_ERROR = undefined; //The text of any returned error

        //They pressed the STOP button while a program was executing
        this.STOP = false;

        // ### CALLBACKS ###
        // Functions defined outside this module but used inside
        this.onData = undefined;
        this.onConnect = undefined;
        this.onDisconnect = undefined;
        this.onFSData = undefined;
        this.doPrintSeparator = undefined;
        this.forceTermNewline = undefined;
        //this.onShowUpdate = undefined;
        this.showMicropythonUpdate = undefined;

        // ### MicroPython Control Commands ###
        // DOCS: https://docs.micropython.org/en/latest/esp8266/tutorial/repl.html#other-control-commands
        // UNICODE CTRL CHARS COMBOS: https://unicodelookup.com/#ctrl
        this.CTRL_CMD_RAWMODE = "\x01";     // ctrl-A (used for waiting to get file information, upload files, run custom python tool, etc)
        this.CTRL_CMD_NORMALMODE = "\x02";  // ctrl-B (user friendly terminal)
        this.CTRL_CMD_KINTERRUPT = "\x03";  // ctrl-C (stops a running program)
        this.CTRL_CMD_SOFTRESET = "\x04";   // ctrl-D (soft reset the board, required after a command is entered in raw!)
        this.CTRL_CMD_PASTEMODE = "\x05";

        this.SPECIAL_FORCE_OUTPUT_FLAG = false;
        this.CATCH_OK = false;

        this.buffer = []; //buffer of read values to catch escape sequences.

        // Use to disable auto connect if manual connecting in progress
        this.MANNUALLY_CONNECTING = false;

        this.READ_UNTIL_STRING = "";    // Set to something not "" to halt until this.READ_UNTIL_STRING found and collect lines in this.COLLECTED_DATA
        this.COLLECTED_DATA = "";

        // Check if browser can use WebSerial
        if ("serial" in navigator) {
            if(this.DEBUG_CONSOLE_ON) console.log("Serial supported in this browser!");
        } else {
            alert("Serial NOT supported in your browser! Use Microsoft Edge or Google Chrome");
            return;
        }


        // Attempt auto-connect when page validated device plugged in, do not start manual selection menu
        navigator.serial.addEventListener('connect', (e) => {
            if(this.MANNUALLY_CONNECTING  == false){
                this.tryAutoConnect();
            }
        });


        // Probably set flags/states when page validated device removed
        navigator.serial.addEventListener('disconnect', (e) => {
            var disconnectedPort = e.target;

            // Only display disconnect message if there is a matching port on auto detect or not already disconnected
            if(this.checkPortMatching(disconnectedPort) && this.DISCONNECT == false){
                if(this.DEBUG_CONSOLE_ON) console.log("%cDisconnected MicroPython!", "color: yellow");
                this.WRITER = undefined;
                this.READER = undefined;
                this.PORT = undefined;
                this.DISCONNECT = true; // Will stop certain events and break any EOT waiting functions
                this.onDisconnect();
                this.BUSY = false;      // If not set false here, if disconnected at just the right time, can't connect until refresh
            }
        });

        document.getElementById("IDConnectThumbyBTN").addEventListener("click", async (event) => {
            if (REPL.DISCONNECT == false) {
                await this.disconnect();
            }
            document.getElementById("IDConnectThumbyBTN").disabled = true;
            await this.connect();
            document.getElementById("IDConnectThumbyBTN").disabled = false;

        });

        this.DISCONNECT = true;
    }


    // Returns true if product and vendor ID match for MicroPython, otherwise false #
    checkPortMatching(port){
        var info = port.getInfo();
        if((info.usbProductId == this.USB_PRODUCT_ID || info.usbProductId == this.USB_PRODUCT_MAC_ID) && info.usbVendorId == this.USB_VENDOR_ID){
            return true;
        }
        return false;
    }


    startCollectRawData(){
        this.COLLECT_RAW_DATA = true;
        this.COLLECTED_RAW_DATA = [];
    }

    endCollectRawData(){
        this.COLLECT_RAW_DATA = false;
    }


    startReaduntil(str){
        this.READ_UNTIL_STRING = str;
        this.COLLECTED_DATA = "";
    }


    // Wait until an OK is received, else write ctrl-c since raw sometimes gets stuck? Seems to work for upload files
    async waitUntilOK(){
        var times = 0;

        while (this.DISCONNECT == false) {
            var tempLines = this.COLLECTED_DATA.split('\r\n');

            for(var i=0; i<tempLines.length; i++){
                if(tempLines[i] == "OK" || tempLines[i] == ">"){
                    return;
                }
            }

            times = times + 1;
            if(times >= 20){
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }


    // Will stall js until finds line set by startReaduntil().
    // Providing an offset will skip subsequent lines after the
    // found line set by startReaduntil.
    // Loops forever if never finds line set by startReaduntil()
    async haltUntilRead(omitOffset = 0, waitTime = -1){
        var waitOmitOffset = 0;
        var numTimes = waitTime;

        // Re-evaluate collected data for readUntil line every 85ms
        while (this.DISCONNECT == false && numTimes != 0) {
            var tempLines = this.COLLECTED_DATA.split('\r\n');

            for(var i=0; i<tempLines.length; i++){
                if(tempLines[i] == this.READ_UNTIL_STRING || this.READ_UNTIL_STRING == "" || tempLines[i].indexOf(this.READ_UNTIL_STRING) != -1
                  || tempLines[i] == ">"){ // Keyboard interrupt
                    // Wait for omitOffset lines
                    if (i > tempLines.length-omitOffset && waitOmitOffset < 5) {
                        waitOmitOffset++;
                        break;
                    }
                    this.READ_UNTIL_STRING = "";

                    // Output the rest of the lines that should not be hidden
                    // Should find a way to do this without adding newlines again

                    for(var j=i+omitOffset; j<tempLines.length; j++){
                        if(j != tempLines.length-1){
                            this.onData(tempLines[j] + "\r\n");
                        }else{
                            this.onData(tempLines[j]);
                        }
                    }

                    return tempLines.slice(0, i+omitOffset);    // Return all lines collected just before the line that switched off haltUntil()
                }
            }
            await new Promise(resolve => setTimeout(resolve, 85));
            if (waitTime != -1){
                numTimes--;
            }
        }
    }

    HandleEsc(value){
        this.buffer = this.buffer.concat(Array.from(value));
        var temp = [];
        var x = this.buffer.lastIndexOf(27); //is there an escape in this string
        if(x == -1){
            temp = this.buffer;
            this.buffer = [];
            return temp;
        }
        else{
            var escEnded = false;
            x++;
            for(x;x<this.buffer.length;x++){
                var char = this.buffer[x];
                if (char >= 65 && char <= 90 || char >= 97 && char <= 122) {
                    escEnded = true;
                    break;
                }
            }
            if(escEnded){
                temp = this.buffer;
                this.buffer = [];
            }
            else{
                temp = [];
            }
            return temp;
        }
    }
    async readLoop(){
        // Everytime the readloop is started means a device was connect/reconnected, reset variables states in case of reconnect
        this._CHUNKS = "";

        while (this.PORT != undefined && this.PORT.readable && this.DISCONNECT == false) {
            // Check if reader locked (can be locked if try to connect again and port was already open but reader wasn't released)
            if(!this.PORT.readable.locked){
                this.READER = this.PORT.readable.getReader();
            }

            try {
                while (true) {
                    // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/read
                    const { value, done } = await this.READER.read();
                    if (done) {
                        // Allow the serial port to be closed later.
                        this.READER.releaseLock();
                        break;
                    }
                    if (value) {
                        // Reading from serial is done in chunks of a inconsistent/non-guaranteed size,
                        if(this.DEBUG_CONSOLE_ON) console.log(this.TEXT_DECODER.decode(value));

                        // Collect lines when read until active, otherwise, output to terminal
                        if(this.READ_UNTIL_STRING == ""){
                            //We need to handle the case where esc sequences are broken up into multiple reads.
                            var tempValue = value;
                            tempValue = this.HandleEsc(tempValue);
                            if(tempValue.length > 0){
                                this.onData(this.TEXT_DECODER.decode(new Uint8Array(tempValue)));
                            }
                        }else{
                            // There are two things going on here.
                            //     1 - When we are running a program, we want all incoming lines to be pushed to the terminal
                            //     2 - Except the very first 'OK'. There are timing issues and this was the best place to catch it.
                            //            This makes the user output look a lot nicer with out the 'OK' showing up.
                            if(this.SPECIAL_FORCE_OUTPUT_FLAG){
                                if (this.CATCH_OK){
                                    let v = this.TEXT_DECODER.decode(value)
                                    if(v.includes("OK")){
                                        this.CATCH_OK = false;
                                    }else{
                                        this.onData(this.TEXT_DECODER.decode(value));
                                    }
                                }else{
                                    this.onData(this.TEXT_DECODER.decode(value));
                                }
                            }

                            this.COLLECTED_DATA += this.TEXT_DECODER.decode(value);

                            // If raw flag set true, collect raw data for now
                            if(this.COLLECT_RAW_DATA == true){
                                for(var i=0; i<value.length; i++){
                                    this.COLLECTED_RAW_DATA.push(value[i]);
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                // TODO: Handle non-fatal read error.
                if(err.name == "NetworkError"){
                    if(this.DEBUG_CONSOLE_ON) console.log("%cDevice most likely unplugged, handled", "color: yellow");
                }
            }
        }
        if(this.DEBUG_CONSOLE_ON) console.log("%cCurrent read loop ended!", "color: yellow");
        this.BUSY = false;
    }


    async writeToDevice(str){
        if(this.WRITER != undefined){
            await this.WRITER.write(this.TEXT_ENCODER.encode(str));
        }else{
            if(this.DEBUG_CONSOLE_ON) console.log("%cNot writing to device, none connected", "color: red");
        }
    }

    async softReset(){
        this.startReaduntil("MPY: soft reboot");
        await this.writeToDevice(this.CTRL_CMD_SOFTRESET);
        await this.haltUntilRead(3);
    }

    // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L325
    async getToNormal(omitOffset = 0){
        await this.getToRaw();  // Get to raw first so that unwanted messages are not printed (like another intro message)

        this.startReaduntil("Raspberry Pi Pico W with RP2040");
        // https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L360 for "\r"
        await this.writeToDevice("\r" + this.CTRL_CMD_NORMALMODE);
        await this.haltUntilRead(omitOffset);
    }

    async getToRaw(){
        this.startReaduntil("raw REPL; CTRL-B to exit");
        // Refer to pyboard.py for "\r" https://github.com/micropython/micropython/blob/master/tools/pyboard.py#L326-L334
        await this.writeToDevice("\r" + this.CTRL_CMD_KINTERRUPT + this.CTRL_CMD_KINTERRUPT);  // ctrl-C twice: interrupt any running program
        await this.writeToDevice("\r" + this.CTRL_CMD_RAWMODE);
        await this.haltUntilRead(2);

        await this.softReset();
    }


    // Goes into raw mode and writes a command according to the THUMBY_SEND_BLOCK_SIZE then executes
    async writeUtilityCmdRaw(cmdStr, waitForCmdEnd = false, omitAmount = 0, customWaitForStr = ">"){
        // Get into raw mode
        await this.getToRaw();

        // Send the cmd string
        var numberOfChunks = Math.ceil(cmdStr.length/this.THUMBY_SEND_BLOCK_SIZE)+1;
        for(var b=0; b < numberOfChunks; b++){
            var writeDataCMD = cmdStr.slice(b*this.THUMBY_SEND_BLOCK_SIZE, (b+1)*this.THUMBY_SEND_BLOCK_SIZE);
            if(this.DEBUG_CONSOLE_ON) console.log(writeDataCMD);
            await this.writeToDevice(writeDataCMD);
        }


        if(waitForCmdEnd){
            this.startReaduntil(customWaitForStr);
            await this.writeToDevice("\x04");
            if(customWaitForStr == ">") await this.waitUntilOK();
            return await this.haltUntilRead(omitAmount, 50); //added timeout since micropython 1.19 sometimes will not get the soft reset and hang
        }else{
            await this.writeToDevice("\x04");
        }
    }

    // Given a path, delete it on RP2040
    async isPowerSwitchOn(path){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd =   "from XRPLib.board import Board\n" +
                    "board = Board.get_default_board()\n" +
                    "print(board.are_motors_powered())\n";


        var hiddenLines = await this.writeUtilityCmdRaw(cmd, true, 1);

        await this.getToNormal(3);
        this.BUSY = false;
        if(hiddenLines[0] == "OKTrue"){
            return true;
        }
        else {
            return false;
        }
    }


    async getOnBoardFSTree(){
        if(this.BUSY == true){
            return;
        }
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in getOnBoardFSTree");

        this.BUSY = true;

        //window.setPercent(1, "Fetching filesystem...");

        var getFilesystemCmd =
        "import machine\n" +
        "#machine.freq(250000000)\n" +   // Speed up the process

        "import os\n" +
        "import ujson\n" +

        "def walk(top, structure, dir):\n" +

        "    extend = \"\";\n" +
        "    if top != \"\":\n" +
        "        extend = extend + \"/\"\n" +

        "    item_index = 0\n" +
        "    structure[dir] = {}\n" +

        "    for dirent in os.listdir(top):\n" +                        // Loop through and create structure of on-board FS
        "        if(os.stat(top + extend + dirent)[0] == 32768):\n" +   // File
        "            structure[dir][item_index] = {\"F\": dirent}\n" +
        "            item_index = item_index + 1\n" +
        "        elif(os.stat(top + extend + dirent)[0] == 16384):\n" + // Dir
        "            structure[dir][item_index] = {\"D\": dirent}\n" +
        "            item_index = item_index + 1\n" +
        "            walk(top + extend + dirent, structure[dir], dirent)\n" +
        "    return structure\n" +
        "struct = {}\n" +
        "print(ujson.dumps(walk(\"\", struct, \"\")))\n";

        var sizeCmd =
        "a = os.statvfs('/')\n" +
        "print(a[0], a[2], a[3])\n";


        //window.setPercent(25, "Fetching filesystem...");
        var hiddenLines = await this.writeUtilityCmdRaw(getFilesystemCmd + sizeCmd, true, 1);

        // Make sure this wasn't executed when no XRP was attached
        if(hiddenLines != undefined){
            this.onFSData(hiddenLines[0].substring(2), hiddenLines[1].split(' '));
        }

        //window.setPercent(65, "Fetching filesystem...");

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: out of getOnBoardFSTree");
        //window.setPercent(100);
        //window.resetPercentDelay();
    }


    async executeLines(lines){
        if(this.BUSY == true){
            return;
        }
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in executeLines");
        this.BUSY = true;
        this.forceTermNewline();

        // Get into raw mode
        await this.getToRaw();

        // Not really needed for hiding output to terminal since raw does not echo
        // but is needed to only grab the FS lines/data

        this.RUN_BUSY  = true;
        this.startReaduntil(">");
        await this.writeToDevice(lines + "\x04");
        this.SPECIAL_FORCE_OUTPUT_FLAG = true;  //you see the OK, but also get any fast output
        this.CATCH_OK = true;
        await this.waitUntilOK();
        var result = await this.haltUntilRead(1);

        /*
                This is where errors can be checked for that were returned incase we want to give a better explanation
                The error information is put into a global variable for end processing if needed.

                If we get an exception here it means that the unplugged or reset the XRP while the program was running.
        */
        this.RUN_ERROR = undefined;
        try{
            for (let i=0;i<result.length;i++){
                if(result[i].includes("[Errno",0)){
                this.RUN_ERROR = result[i];
                }
            }
        }
        catch{
            this.SPECIAL_FORCE_OUTPUT_FLAG = false;
            this.BUSY = false;
            this.RUN_BUSY = false;
            return;
        }

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        this.SPECIAL_FORCE_OUTPUT_FLAG = false;
        await this.getToRaw();
        this.SPECIAL_FORCE_OUTPUT_FLAG = true;

        this.doPrintSeparator();

        this.startReaduntil("Raspberry Pi Pico W with RP2040");
        await this.writeToDevice("\r" + this.CTRL_CMD_NORMALMODE);
        await this.haltUntilRead(3);

        // if they pushed the stop button while lines was executing
        if(this.STOP) {
            this.SPECIAL_FORCE_OUTPUT_FLAG = false;
            this.STOP = false
            //We were hammering on ctrl-c up to get the program to stop (because timer routines don't stop).
            //Meaning finally did not run. We will run the resetbot routine
            var cmd = "import sys\n"+
                        "if 'XRPLib.resetbot' in sys.modules:\n" +
                        "   del sys.modules['XRPLib.resetbot']\n" +
                        "from XRPLib.resetbot import reset_hard\n" +
                        "reset_hard()\n"
            await this.writeUtilityCmdRaw(cmd, true, 1);
        }

        this.BUSY = false;
        this.RUN_BUSY = false;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: out of executeLines");


        // Make sure to update the filesystem after modifying it
        this.SPECIAL_FORCE_OUTPUT_FLAG = false;
        await this.getOnBoardFSTree();
    }


    // Given a path, delete it on RP2040
    async deleteFileOrDir(path){
        if(path != undefined){
            if(this.BUSY == true){
                return;
            }
            this.BUSY = true;

            window.setPercent(1, "Deleting...");
            var cmd =   "import os\n" +
                        "def rm(d):  # Remove file or tree\n" +
                        "   try:\n" +
                        "       if os.stat(d)[0] & 0x4000:  # Dir\n" +
                        "           for f in os.ilistdir(d):\n" +
                        "               if f[0] not in ('.', '..'):\n" +
                        "                   rm('/'.join((d, f[0])))  # File or Dir\n" +
                        "           os.rmdir(d)\n" +
                        "       else:  # File\n" +
                        "           os.remove(d)\n" +
                        "       print('rm_worked')\n" +
                        "   except:\n" +
                        "       print('rm_failed')\n" +
                        "rm('" + path + "')\n";


            window.setPercent(2);
            await this.writeUtilityCmdRaw(cmd, true, 1);
            window.setPercent(55);

            // Get back into normal mode and omit the 3 lines from the normal message,
            // don't want to repeat (assumes already on a normal prompt)
            await this.getToNormal(3);
            this.BUSY = false;

            // Make sure to update the filesystem after modifying it
            await this.getOnBoardFSTree();
            window.setPercent(100);
            window.resetPercentDelay();
        }
    }


    // Sends commands to RP2040 to rename file at given path to provided new name
    async renameFile(oldPath, newName){
        if(oldPath != undefined && newName != undefined && newName != null && newName != ""){
            if(this.BUSY == true){
                return;
            }
            this.BUSY = true;
            window.setPercent(1, "Renaming file...");

            var newPath = oldPath.substring(0, oldPath.lastIndexOf("/")+1) + newName;
            var cmd =   "import uos\n" +
                        "exists = 1\n" +
                        "try:\n" +
                        "   f = open('" + newPath + "', 'r')\n" +
                        "   exists = 1\n" +
                        "   f.close()\n" +
                        "except  OSError:\n" +
                        "   exists = 0\n" +
                        "if exists == 0:\n" +
                        "   uos.rename('" + oldPath + "', '" + newPath +"')\n" +
                        "   print('no_rename_error')\n" +
                        "else:\n" +
                        "   print('rename_error')\n";

            window.setPercent(2);
            await this.writeUtilityCmdRaw(cmd, true, 1);
            window.setPercent(55);

            // Get back into normal mode and omit the 3 lines from the normal message,
            // don't want to repeat (assumes already on a normal prompt)
            await this.getToNormal(3);
            this.BUSY = false;

            // Make sure to update the filesystem after modifying it
            await this.getOnBoardFSTree();
            window.setPercent(100);
            window.resetPercentDelay();
        }
    }


    async downloadFile(filePath) {
        let response = await fetch(filePath);

        if(response.status != 200) {
            throw new Error("Server Error");
        }

        // read response stream as text
        let text_data = await response.text();

        return text_data;
    }


    async deleteAllFiles(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd =   "import os\n" +
                    "def rm(d):  # Remove file or tree\n" +
                    "   try:\n" +
                    "       if os.stat(d)[0] & 0x4000:  # Dir\n" +
                    "           for f in os.ilistdir(d):\n" +
                    "               if f[0] not in ('.', '..'):\n" +
                    "                   rm('/'.join((d, f[0])))  # File or Dir\n" +
                    "           os.rmdir(d)\n" +
                    "       else:  # File\n" +
                    "           os.remove(d)\n" +
                    "       print('rm_worked')\n" +
                    "   except:\n" +
                    "       print('rm_failed')\n" +
                    "filelist = os.listdir('/')\n" +
                    "for f in filelist:\n" +
                    "    rm('/' + f)\n";

        await this.writeUtilityCmdRaw(cmd, true, 1);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;
    }


    async buildPath(path){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in buildPath");;


        // Got through and make sure entire path already exists
        var cmd = "import uos\n" +
                  "try:\n" +
                  "    path = '" + path + "'\n" +
                  "    path = path.split('/')\n" +
                  "    builtPath = path[0]\n" +
                  "    for i in range(1, len(path)+1):\n" +
                  "        try:\n" +
                  "            uos.mkdir(builtPath)\n" +
                  "        except OSError:\n" +
                  "            print('Directory already exists, did not make a new folder')\n" +
                  "        if i < len(path):\n" +
                  "            builtPath = builtPath + '/' + path[i]\n" +
                  "except Exception as err:\n" +
                  "    print('Some kind of error while building path...' + err)\n";

        await this.writeUtilityCmdRaw(cmd, true, 1);

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);

        this.BUSY = false;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: out of buildPath");

    }


    async uploadFile(filePath, fileContents, usePercent = false){
        if(this.BUSY == true){
            return true;
        }

        var pathToFile = filePath.substring(0, filePath.lastIndexOf('/'));
        await this.buildPath(pathToFile);

        this.BUSY = true;
        if(usePercent) window.setPercent(1, "Saving file...");

        if(usePercent) window.setPercent(2);

        // Convert strings to binary
        var bytes = undefined;
        if(typeof fileContents == "string"){
            bytes = new Uint8Array(fileContents.length);
            for(var i = 0; i < fileContents.length; i++) {
                bytes[i] = fileContents.charCodeAt(i);
            }
        }else{
            bytes = fileContents;
        }

        //[TODO] - This should be just the length of what is available. Not just 2MB
        if(bytes.length >= 2000000){
            alert("This file is at least 2MB, too large, not uploading");
            return;
        }


        // https://forum.micropython.org/viewtopic.php?t=10659&p=58710
        var writeFileScript =   "import micropython\n" +
                                "import sys\n" +
                                "import time\n" +
                                "micropython.kbd_intr(-1)\n" +
                                "print('started')\n" +
                                "w = open('" + filePath + "','wb')\n" +

                                "byte_count_to_read = -1\n" +
                                "read_byte_count = -7\n" +
                                "read_buffer = bytearray(255)\n" +
                                "specialStartIndex = 0\n" +
                                "specialEndIndex = 255\n" +
                                "while True:\n" +
                                "    read_byte_count = read_byte_count + sys.stdin.buffer.readinto(read_buffer, 255)\n" +

                                "    if byte_count_to_read == -1:\n" +
                                "        time.sleep(0.025)\n" +
                                "        byte_count_to_read = int(read_buffer[0:7].decode('utf-8'))\n" +
                                // "        print(byte_count_to_read)\n" +
                                // "        sys.stdout.write('EOF')\n" +
                                "        specialIndex = 7\n" +

                                "    if read_byte_count >= byte_count_to_read:\n" +
                                "        specialEndIndex = 255 - (read_byte_count - byte_count_to_read)\n" +
                                "        read_byte_count = read_byte_count - 255 + specialEndIndex\n" +

                                "    w.write(bytearray(read_buffer[specialIndex:specialEndIndex]))\n" +
                                "    specialIndex = 0\n" +
                                // "    print(read_byte_count)\n" +
                                // "    sys.stdout.write('EOF')\n" +
                                "    if read_byte_count >= byte_count_to_read:\n" +
                                "        break\n" +
                                "w.close()\n" +

                                "micropython.kbd_intr(0x03)\n";



        await this.writeUtilityCmdRaw(writeFileScript, true, 1, "started");  //we wait until we print started, otherwise we may write a binary ctl character before the micropython.kbd_intr(-1)

        // https://stackoverflow.com/a/1127966
        var bytesLenStr = "" + bytes.length;
        while (bytesLenStr.length < 7) {
            bytesLenStr = "0" + bytesLenStr;
        }
        await this.writeToDevice(bytesLenStr);


        if(usePercent) window.setPercent(3);

        var numberOfChunks = Math.ceil(bytes.length/this.THUMBY_SEND_BLOCK_SIZE)+1;
        var currentPercent = 3;
        var endingPercent = 98;
        var percentStep = (endingPercent - currentPercent) / numberOfChunks;


        var bytesSent = 0;
        for(var b=0; b < numberOfChunks; b++){
            var writeDataCMD = bytes.slice(b*this.THUMBY_SEND_BLOCK_SIZE, (b+1)*this.THUMBY_SEND_BLOCK_SIZE);

            bytesSent = bytesSent + writeDataCMD.length;

            if(bytesSent == bytes.length && writeDataCMD.length < this.THUMBY_SEND_BLOCK_SIZE){
                var fillerArray = new Uint8Array(this.THUMBY_SEND_BLOCK_SIZE - writeDataCMD.length);
                for(var i = 0; i < fillerArray.length; i++){
                    fillerArray[i] = 255;
                }

                var finalArray = new Uint8Array(writeDataCMD.length + fillerArray.length);
                finalArray.set(writeDataCMD, 0);
                finalArray.set(fillerArray, writeDataCMD.length);
                writeDataCMD = finalArray;
            }

            if(this.WRITER != undefined){
                // this.startReaduntil("EOF");
                await this.WRITER.write(writeDataCMD);
                //console.log("Sent file chunk: " + b);
                // await this.haltUntilRead(0);
            }else{
                if(this.DEBUG_CONSOLE_ON) console.log("%cNot writing to device, none connected", "color: red");
            }

            currentPercent = currentPercent + percentStep;
            if(usePercent) window.setPercent(currentPercent);
        }

        // await this.haltUntilRead(1);
        await this.getToNormal(3);
        if(usePercent) window.resetPercentDelay();
        this.BUSY = false;
    }


    async format(){
        await this.deleteAllFiles();
        await this.getOnBoardFSTree();

        //window.setPercent(1, "Formatting Thumby...");

        //await this.uploadFile("Games/SpaceDebris/SpaceDebris.py", await window.downloadFile("ThumbyGames/Games/SpaceDebris/SpaceDebris.py"), false);
        //window.setPercent(7.7);

        window.resetPercentDelay();
    }


    async getVersionInfo(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in getVersionInfo");


        var cmd =   "import os\n" +
                    "import sys\n" +
                    "import machine\n" +

                    "print(sys.implementation[1])\n" +
                    "try:\n" +
                    "    f = open(\"/lib/XRPLib/version.py\", \"r\")\n" +
                    "    while True:\n" +
                    "        line = f.readline()\n" +
                    "        if len(line) == 0:\n" +
                    "            print(\"ERROR EOF\")\n" +
                    "            break\n" +
                    "        if \"__version__ = \" in line:\n" +
                    "            print(line.split('\\\'')[1])\n" +
                    "            break\n" +
                    "except:\n" +
                    "    print(\"ERROR EX\")\n" +
                    "print(''.join(['{:02x}'.format(b) for b in machine.unique_id()]));";
                   

        var hiddenLines = await this.writeUtilityCmdRaw(cmd, true, 1);

        await this.getToNormal(3);
        this.BUSY = false;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: out of getVerionINfo");

        if(hiddenLines != undefined){
            if(hiddenLines[0].substring(2) != "ERROR"){
                return [hiddenLines[0].substring(2), hiddenLines[1], hiddenLines[2]];
            }else{
                console.error("Error getting version information");
            }
        }
    }


    async update(){
        //window.setPercent(1, "Updating Thumby...");
        //await this.uploadFile("lib/ssd1306.py", await window.downloadFile("ThumbyGames/lib/ssd1306.py"), false);

        // Make sure to update the filesystem after modifying it
        await this.getOnBoardFSTree();
        window.resetPercentDelay();
    }

    async updateMainFile(fileToEx){
       
        var fileToEx2 = fileToEx;
        if (fileToEx.startsWith('/')) {
            fileToEx2 = fileToEx.slice(1);
        }
        
        var value = "try:\n" +
                    "   with open('"+fileToEx+"', mode='r') as exfile:\n" +
                    "       code = exfile.read()\n"+
                    "   execCode = compile(code, '" +fileToEx2+"', 'exec')\n" +
                    "   exec(execCode)\n" +
                    "except Exception as e:\n" +
                    "   import sys\n" +
                    "   sys.print_exception(e)\n"+
                    "finally:\n"+
                    "   import XRPLib.resetbot";
        await this.uploadFile("//main.py", value, true, false);
        window.resetPercentDelay();
        return value;
    }

    async uploadFiles(path, fileHandles){
        if(this.BUSY == true){
            //[TODO] Need to notifiy user
            return;
        }
        UIkit.modal(document.getElementById("IDProgressBarParent")).show();

        window.setPercent(1, "Saving files...");
        let percent_per = 99 / fileHandles.length;
        let cur_percent = 1 + percent_per;

        for(var i=0; i<fileHandles.length; i++){
            window.setPercent(cur_percent);
            cur_percent += percent_per;
            const file = await fileHandles[i].getFile();

            const bytes = new Uint8Array(await file.arrayBuffer());
            //[TODO] Should we be doing this check? - it seems yes so that .mpy files get binary encoded.
            if(file.name.indexOf(".py") != -1 || file.name.indexOf(".txt") != -1 || file.name.indexOf(".text") != -1 || file.name.indexOf(".cfg") != -1){
                await this.uploadFile(path + file.name, await file.text(), true);
            }else{
                await this.uploadFile(path + file.name, new Uint8Array(await file.arrayBuffer()), true);
            }
        }

        window.resetPercentDelay();
        UIkit.modal(document.getElementById("IDProgressBarParent")).hide();

        await this.getOnBoardFSTree();
    }


    async getFileContents(filePath){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd =   "import sys\n" +
                    "chunk_size = 256\n" +
                    "onboard_file = open('" + filePath + "', 'rb')\n" +
                    "while True:\n" +
                    "    data = onboard_file.read(chunk_size)\n" +
                    "    if not data:\n" +
                    "        break\n" +
                    "    sys.stdout.buffer.write(data)\n" +
                    "onboard_file.close()\n" +
                    "sys.stdout.write('###DONE READING FILE###')\n";

        // Get into raw mode
        await this.getToRaw();

        // Not really needed for hiding output to terminal since raw does not echo
        // but is needed to only grab the FS lines/data
        this.startCollectRawData();
        this.startReaduntil("###DONE READING FILE###");
        await this.writeToDevice(cmd + "\x04");

        // fielcontents only used for case of script ascii, otherwise use COLLECTED_RAW_DATA to get raw binary data to save
        var fileContents = undefined;
        await this.haltUntilRead(2);

        this.endCollectRawData();

        // Get back into normal mode and omit the 3 lines from the normal message,
        // don't want to repeat (assumes already on a normal prompt)
        await this.getToNormal(3);
        this.BUSY = false;

        return this.COLLECTED_RAW_DATA.slice(2, this.COLLECTED_RAW_DATA.length-26);     // Get rid of 'OK' and '###DONE READING FILE###'
    }


    async checkFileExists(filePath){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        var cmd = "import os\n" +
                  "try:\n" +
                  "    os.stat(\"\"\""+filePath+"\"\"\")\n" +
                  "    print('EXISTS')\n"+
                  "except:\n"+
                  "    print('NONE')\n"

        var hiddenLines = await this.writeUtilityCmdRaw(cmd, true, 1);
        await this.getToNormal(3);
        this.BUSY = false;
        return hiddenLines && hiddenLines[0].endsWith("EXISTS");
    }


    async checkIfNeedUpdate(){
        //if no micropython on the XRP
        if(!this.HAS_MICROPYTHON){
             await this.showMicropythonUpdate();
             return;
        }

        //get version information from the XRP
        let info = await this.getVersionInfo();

        window.xrpID = info[2]; //store off the unique ID for this XRP

        info[0]= info[0].replace(/[\(\)]/g, "").replace(/,\s/g, "."); //convert to a semantic version
        //if the microPython is out of date
        if(this.isVersionNewer(window.latestMicroPythonVersion, info[0])){
            // Need to update MicroPython
            //alert("Need to update Micropython")
            await this.showMicropythonUpdate();
        }

        //if no library or the library is out of date
        if(Number.isNaN(parseFloat(info[1])) || this.isVersionNewer(window.latestLibraryVersion, info[1])){
            await this.updateLibrary(info[1]);
        }
    }

    isVersionNewer(v1, v2) {
        let v1parts = v1;
        let v2parts = v2.split('.').map(Number);

        while (v1parts.length < v2parts.length) v1parts.push(0);
        while (v2parts.length < v1parts.length) v2parts.push(0);

        for (let i = 0; i < v1parts.length; ++i) {
            if (v1parts[i] > v2parts[i]) {
                return true;
            } else if (v1parts[i] < v2parts[i]) {
                return false;
            }
        }
        return false;
    }

    async updateLibrary(curVer){
        if(curVer == "ERROR EX"){
            curVer = "None";
        }
        let answer = await window.confirmMessage("The library files on the XRP are out of date.<br>" +
                "The current version is " + curVer +
                " and the new version is version " + window.latestLibraryVersion[0] + "." + window.latestLibraryVersion[1] + "." + window.latestLibraryVersion[2] +"<br>" +
                "Click OK to update the XRP to the latest version.");
        if (!answer) {
            return; //they pressed CANCEL
        }

        UIkit.modal(document.getElementById("IDProgressBarParent")).show();
        document.getElementById("IdProgress_TitleText").innerText = 'Update in Progress...';

        let response = await fetch("lib/package.json");
        response = await response.text();
        let jresp = JSON.parse(response);
        var urls = jresp.urls;
        window.setPercent(1, "Updating XRPLib...");
        let percent_per = Math.round(99 / (urls.length + window.phewList.length));
        let cur_percent = 1 + percent_per;

        await this.deleteFileOrDir("/lib/XRPLib");  //delete all the files first to avoid any confusion.
        for(let i=0; i<urls.length; i++){
            window.setPercent(cur_percent, "Updating XRPLib...");
            //console.log("percent = " + cur_percent);
            //added a version number to ensure that the browser does not cache it.
            let next = urls[i];
            var parts = next[0];
            parts = parts.replace("XRPLib", "lib/XRPLib");
            await this.uploadFile(parts, await window.downloadFile(parts.replace("XRPExamples", "lib/Examples") + "?version=" + window.latestLibraryVersion[2]));
            cur_percent += percent_per;
        }

        //create a version.py file that has the version in it for future checks
        await this.uploadFile("lib/XRPLib/version.py", "__version__ = '" + window.latestLibraryVersion[0] + "." + window.latestLibraryVersion[1] + "." + window.latestLibraryVersion[2] + "'\n" );
        // await this.uploadFile("lib/pestolink.py", window.downloadFile("lib/XRPLib/pestolink.py"));
        cur_percent += percent_per;


        await this.deleteFileOrDir("/lib/phew");  //delete all the files first to avoid any confusion.
        for(let i=0; i<window.phewList.length; i++){
            window.setPercent(cur_percent, "Updating XRPLib...");
            //console.log("percent = " + cur_percent);
            //added a version number to ensure that the browser does not cache it.
            await this.uploadFile("lib/phew/" + window.phewList[i], await window.downloadFile("lib/phew/" + window.phewList[i] + "?version=" + window.latestLibraryVersion[2]));
            cur_percent += percent_per;
        }

        window.resetPercentDelay();
        await this.getOnBoardFSTree();
        UIkit.modal(document.getElementById("IDProgressBarParent")).hide();
        location.reload();
    }

    async updateMicroPython() {

        UIkit.modal(document.getElementById("IDProgressBarParent")).show();
        document.getElementById("IdProgress_TitleText").innerText = 'Update in Progress...';

        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;

        window.setPercent(1, "Updating MicroPython...");

        if(this.HAS_MICROPYTHON){
            let cmd = "import machine\n" +
                    "machine.bootloader()\n";

            await this.getToRaw();

            this.startReaduntil("OK");
            await this.writeToDevice(cmd + "\x04");
        }
        var writable;
        window.setPercent(3);
        try{
            //message select the RPI-RP2
            let dirHandler = await window.showDirectoryPicker({mode: "readwrite"});
            let fileHandle = await dirHandler.getFileHandle("firmware.uf2", {create: true});
            writable = await fileHandle.createWritable();
        }catch(err){
            console.log(err);
            UIkit.modal(document.getElementById("IDProgressBarParent")).hide();
            window.alertMessage("Error updating MicroPython. Please try again.");
            this.BUSY = false;
            return;                                                                     // If the user doesn't allow tab to save to opened file, don't edit file
        }

        window.setPercent(35);
        let data = await (await fetch("micropython/firmware.uf2")).arrayBuffer();
        window.setPercent(85);
        //message to click on Edit Files
        await writable.write(data);
        //at some point after this write the PICO will reboot
        window.resetPercentDelay();
        this.HAS_MICROPYTHON = true;
        try{
            await writable.close();
        }
        catch{
            console.log("PICO rebooted before close - this is ok");
        }

        this.BUSY = false;
        // hide modal after installation is complete
        UIkit.modal(document.getElementById("IDProgressBarParent")).hide();
    }

    async stopTheRobot(){
        //This is a complicated task since the different conditions. The Micropython could be in one of 2 states
        //  1 - Sitting at the REPL prompt ready to go
        //  2 - Running a program
        //
        //    If running a program then we need to send a ctrl-c to stop the program.
        //    This brings up 3 conditions:
        //       1 - The ctrl-c stopped the program and we are back at the prompt
        //       2 - We were in RAW mode, so try going to NORMAL mode(get REPL output again), if we get a prompt then done
        //       3 - It took the ctrl-c but since the program was in a different thread (timers are the most likely) it didn't stop the program
        //          For this one we need to try a few more times in hopes the program will be in a state we can interrupt. If not ask the user to
        //             reset and try again.


        this.startReaduntil(">>>");
        await this.writeToDevice("\r"); //do a linefeed and see if the REPL responds
        var result = await this.haltUntilRead(1, 10); //this should be fast

        if (result == undefined){

            this.startReaduntil("KeyboardInterrupt:");
            await this.writeToDevice("\r" + this.CTRL_CMD_KINTERRUPT);  // ctrl-C to interrupt any running program
            result = await this.haltUntilRead(1, 20);
            if(result == undefined){
                this.startReaduntil(">>>");
                await this.writeToDevice("\r" + this.CTRL_CMD_NORMALMODE);  // ctrl-C to interrupt any running program
                result = await this.haltUntilRead(1, 20);
                if(result != undefined){
                    return true;
                }
            }
            //try multiple times to get to the prompt
            var gotToPrompt = false;
            for(let i=0;i<20;i++){
                this.startReaduntil(">>>");
                await this.writeToDevice("\r" + this.CTRL_CMD_KINTERRUPT);
                result = await this.haltUntilRead(2, 5); //this should be fast
                if(result != undefined){
                    gotToPrompt = true;
                    break;
                }
            }
            return gotToPrompt;
        }
        return true;
    }


    async checkIfMP(){

        if(! await this.stopTheRobot()){
            this.HAS_MICROPYTHON = false;
            let ans = await window.confirmMessage("XRPCode is having problems connecting to this XRP.<br>" +
                                                        "Two Options:" + 
                                                        "<ul><li>Unplug the XRP checking the cable on both ends</li>" +
                                                        "<li>Turn the XRP power to off</li>" + 
                                                        "<li>Click OK and then plug the XRP in again</li></ul>" + 
                                                        "<br>Or click CANCEL and XRPCode will reinstall MicroPython onto the XRP")
            return ans;
        }

        // do a softreset, but time out if no response
        this.startReaduntil("MPY: soft reboot");
        await this.writeToDevice(this.CTRL_CMD_SOFTRESET);
        await this.haltUntilRead(3, 20);  //FCG - is this the right amount of delay to always work?

        this.HAS_MICROPYTHON = true;
        return true;
    }
    async openPort(){
        if(this.PORT != undefined){
            this.DISCONNECT = false;
            try{
                await this.PORT.open({ baudRate: 115200 });
                this.WRITER = await this.PORT.writable.getWriter();     // Make a writer since this is the first time port opened
                this.readLoop();                // Start read loop
                if(await this.checkIfMP()){
                    if(this.HAS_MICROPYTHON == false){    //something went wrong, just get out of here
                        return;
                    }
                    this.BUSY = false;
                    await this.getToNormal();
                    await this.getOnBoardFSTree();
                    this.onConnect();
                }

                this.BUSY = false;
                await this.checkIfNeedUpdate();

            }catch(err){
                if(err.name == "InvalidStateError"){
                    if(this.DEBUG_CONSOLE_ON) console.log("%cPort already open, everything good to go!", "color: lime");
                    if (await this.checkIfMP()){
                        if(this.HAS_MICROPYTHON == false){    //something went wrong, just get out of here
                            return;
                        }
                        this.onConnect();
                        this.BUSY = false;
                        await this.getToNormal();

                        await this.getOnBoardFSTree();
                    }

                    this.BUSY = false;
                    await this.checkIfNeedUpdate();

                }else if(err.name == "NetworkError"){
                    alert("Opening port failed, is another application accessing this device/port?");
                    if(this.DEBUG_CONSOLE_ON) console.log("%cOpening port failed, is another application accessing this device/port?", "color: red");
                }
            }
        }else{
            console.error("Port undefined!");
        }
    }


    async tryAutoConnect(){
        if(this.BUSY == true){
            return;
        }
        this.BUSY = true;
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in tryAutoConnect");
    
        window.ATERM.writeln("Connecting to XRP..."); //let the user know that we are trying to connect.

        if(this.DEBUG_CONSOLE_ON) console.log("%cTrying auto connect...", "color: yellow");
        var ports = await navigator.serial.getPorts();
        if(Array.isArray(ports)){
            for(var ip=0; ip<ports.length; ports++){
                if(this.checkPortMatching(ports[ip])) {
                    this.PORT = ports[ip];
                    if(this.DEBUG_CONSOLE_ON) console.log("%cAuto connected!", "color: lime");
                    await this.openPort();
                    this.BUSY = false;
                    if (this.DEBUG_CONSOLE_ON) console.log("fcg: out of tryAutoConnect");
                    return true;
                }
            }
        } else {
            if(this.checkPortmatching(ports)) {
                this.PORT = ports; 
                if(this.DEBUG_CONSOLE_ON) console.log("%cAuto connected!", "color: lime");
                await this.openPort();
                this.BUSY = false;
                if (this.DEBUG_CONSOLE_ON) console.log("fcg: out of tryAutoConnect");
                return true;
            }
        }
        if (this.DEBUG_CONSOLE_ON)
            console.log("%cNot Auto connected...", "color: yellow");
            document.getElementById('IDConnectThumbyBTN').style.display = "block";
            this.BUSY = false;

        if (this.DEBUG_CONSOLE_ON)
            console.log("fcg: out of tryAutoConnect");
        return false;
    }


    async connect(){
        if(this.BUSY == true){
            return;
        }

        var autoConnected = await this.tryAutoConnect();

        const usbVendorId = this.USB_VENDOR_ID;
        const usbProductId = this.USB_PRODUCT_ID;
        const usbProductMacId = this.USB_PRODUCT_MAC_ID;

        if(!autoConnected){
            if(this.DEBUG_CONSOLE_ON) console.log("fcg: in tryAutoConnect");

            this.BUSY = true;
            this.MANNUALLY_CONNECTING = true;
            if(this.DEBUG_CONSOLE_ON) console.log("%cTrying manual connect..", "color: yellow");

            await navigator.serial.requestPort({filters: [{ usbVendorId, usbProductId }, { usbVendorId, usbProductMacId }]}).then(async (port) => {
                this.PORT = port;
                if(this.DEBUG_CONSOLE_ON) console.log("%cManually connected!", "color: lime");
                await this.openPort();
            }).catch((err) => {
                if (this.DEBUG_CONSOLE_ON)
                    console.log("%cNot manually connected...", "color: yellow");
                    document.getElementById('IDConnectThumbyBTN').style.display = "block";
                //alert("Didn't see XRP?\n\nCheck the following:\n* XRP is on\n* MicroUSB cable is plugged into XRP and computer\n* MicroUSB cable has data lines (some cables only transfer power)");
            });
            this.MANNUALLY_CONNECTING = false;
            this.BUSY = false;
            if (this.DEBUG_CONSOLE_ON)
                console.log("fcg: out of tryAutoConnect");
        }
    }

    async stop(){
        if(this.DEBUG_CONSOLE_ON) console.log("fcg: in stop");

        if(this.BUSY && this.RUN_BUSY == false){    //don't try and STOP if the code is BUSY but not from Running a user program.
            return;
        }
        if(this.RUN_BUSY){  //if the program is running do ctrl-c until we know it has stopped
            this.STOP = true;  //let the executeLines code know when it stops, it stopped because the STOP button was pushed
            this.SPECIAL_FORCE_OUTPUT_FLAG = false; //turn off showing output so they don't see the keyboardInterrupt and stack trace.
            var count = 1;
            /*
                We are BUSY, this means that there is another thread that started the program.
                Because they could be in a timer we are going to hammer ctrl-c until we know they are out of the program.
                The problem with this is that we will end up sending a ctrl-c during the finally that is running the resetbot.
            */
            while (this.STOP) {
                await this.writeToDevice("\r" + this.CTRL_CMD_KINTERRUPT);  // ctrl-C to interrupt any running program
                count += 1;
                if (count > 20){
                    break;
                }
            }
            //document.getElementById('IDRunBTN').style.display = "block";
            return

        }
        // I don't think this code will run anymore since there is no stop button when a program is not running.

        //The user pushed STOP while things were idle. Lets make sure the robot is stopped and run restbot.
        await this.stopTheRobot();  //make sure the robot is really stopped

        //document.getElementById('IDRunBTN').style.display = "block";
        // Then just invoke resetbot to stop all motors
        var cmd = "import XRPLib.resetbot\n"
        await this.writeUtilityCmdRaw(cmd, true, 1);
        await this.getToNormal(3);
    }

    async disconnect(){
        if(this.PORT != undefined){
            this.DISCONNECT = true;
            this.READER.cancel();
            this.READER.releaseLock();
            this.WRITER.releaseLock();
            this.PORT.close();

            this.READER = undefined;
            this.WRITER = undefined;
            this.PORT = undefined;

            this.onDisconnect();
        }
    }
}
