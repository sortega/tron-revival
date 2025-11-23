COMPILER_OPTIONS _extended_conditions;
//------------------------------------------------------------------//
//TITULO:       TERA-TRON                                           //
//AUTOR:        SEBASTIAN ORTEGA                                    //
//FECHA:        09/08/01                                            //
//------------------------------------------------------------------//

PROGRAM Tera_Tron;
CONST
  MinMap=200;
  MaxMap=207;
  Escudados=0;
GLOBAL
  Nombre[4]=" Rojo "," Verde "," Azul "," Amarillo ";
  fotos,boom,titlefont,panelfont,opciofont;
  sel;
  struct Preferencias
    mapa=-1;
  end;
  struct Controls[4]
    izq,der,esp;
  end=_z,        _x,        _control,
      _left,     _right,    _c_ins,
      _l,        _semicolon,_k,
      _c_del,    _c_enter,  _c_plus;
  npl=0;
  nvivos=0;
  ids[4]= 0,0,0,0;
  ptos[4]=0,0,0,0;
  winner;
  mapa=MinMap;
  vs=0;
  itlch=0;
  playing=0;
  //Sonidos
  Inicio,escopeta,armado,tiro,straya,explosi¢n,bombava,alarma,reset,turbo,lento,shield,fusil,uah,wc,torno;
  //Raton
  oldx=0;
LOCAL
  rx=0,ry=0,dir=0,cruces=0,color=0,escudo=0,vivo=1,num;
  fase=-1,ammo=0,target=0;
  vel=100,ctrl=1;
  bocas[2]=0,0;
PRIVATE
  i=0;
BEGIN
  fotos=load_fpg("tron.fpg");

  //set_mode(m640x400);
  set_mode(m376x282);
  set_fps(70,5);
  put_screen(fotos,3);
  fade_off();
  //fade(100,100,100,1);
  fade_on();
  while(scan_code==0 and fading); frame; end;
  //start_fli("Intro.fli",160,80);
  start_fli("Intro.fli",28,21);
  REPEAT
    i=frame_fli();
    FRAME(130);
  UNTIL(i==0 or key(_space));
  WHILE (scan_code==0 and !key(_space)) FRAME; end;
  end_fli();

  set_mode(m800x600);
  define_region(1,0,0,750,600);
  define_region(2,750,0,50,600);
  fade_off();
  //Cargamos
  boom=load_fpg("boom.fpg");
  load_pal("tron.fpg");
  titlefont=load_fnt("titlefon.fnt");
  panelfont=load_fnt("panelfon.fnt");
  opciofont=load_fnt("opcionfon.fnt");
  //sonidos
  Inicio=   load_wav("Inicio.wav",  0);
  Escopeta= load_wav("Escopeta.wav",0);
  Armado=   load_wav("armado.wav",  0);
  Tiro=     load_wav("Tiro.wav",    0);
  STraya=   load_wav("traya.wav",   1);
  explosi¢n=load_wav("Boom.wav",    0);
  bombava=  load_wav("bombava.wav", 0);
  alarma=   load_wav("alarma.wav",  1);
  reset=    load_wav("reset.wav",   0);
  turbo=    load_wav("Turbo.wav",   0);
  lento=    load_wav("lento.wav",   0);
  shield=   load_wav("escudo.wav",  0);
  fusil=    load_wav("fusil.wav",   0);
  uah=      load_wav("uah.wav",     0);
  wc=       load_wav("wc.wav",      0);
  torno=    load_wav("torno.wav",   1);

  sel=0;
REPEAT
  put_screen(fotos,1);
  write(titlefont,400,60,4,"TERATRON");
  write(titlefont,400,160,4,"1. Jugar(2)");
  write(titlefont,400,240,4,"2. Jugar(3)");
  write(titlefont,400,320,4,"3. Jugar(4)");
  write(titlefont,400,400,4,"4. Jugar(2 vs 2)");
  //write(titlefont,400,480,4,"5. Opciones");
  write(titlefont,400,560,4,"6. Puerta");
  fade_on();
 WHILE(sel==0)
  switch(scan_code)
    case _1,_enter:
      sel=1;
      end;
    case _2:
      sel=2;
      end;
    case _3:
      sel=3;
    end;
    case _4:
      sel=4;
    end;
    case _5:
      //sel=5;
    end;
    case _6,_esc:
      sel=6;
    end;
    default:
      sel=0;
      end;
  end;
  FRAME;
 END;
  delete_text(all_text);
  clear_screen();

  //Jugar
  if (sel>0 and sel<4)
    npl=sel+1;
    Jugar();
  end;
  if (sel==4)
    npl=4;
    JugarVS();
  end;
  if (sel==5)
    Opciones();
  end;

UNTIL(sel==6);
  exit("",0);
END;

FUNCTION Opciones();
PRIVATE
  opt=0;
BEGIN
  LoadPreferencias();
  put_screen(fotos,300);
  file=fotos;
  size=37;
  x=250;
  y=313;
  if (preferencias.mapa!=-1)
    graph=minmap+preferencias.mapa;
    Hueco();
  else
    graph=0;
  end;
  while(opt!=-1)
    if(key(_esc))
       opt=-1;
    end;
    if(key(_1))
      preferencias.mapa++;
      if(preferencias.mapa>maxmap-minmap)
        preferencias.mapa=-1;
        graph=0;
        signal(type hueco,s_kill);
      else
        graph=minmap+preferencias.mapa;
        Hueco();
      end;
    end;
    frame;
  end;

  clear_screen();
  delete_text(all_text);
  SavePreferencias();
  sel=0;
END

PROCESS Hueco()
BEGIN
  z=1;
  file=fotos;
  graph=6;
  x=250;
  y=313;
  while(sel=5)
    frame;
  end;
END;

FUNCTION LoadPreferencias()
Private F;
BEGIN
  F=fopen("opciones.dat","r");
  if(F)
    fread(&preferencias,sizeof(preferencias),F);
    fclose(f);
  end;
END;

FUNCTION SavePreferencias()
Private
  F;
BEGIN
  F=fopen("opciones.dat","w");
  fwrite(&preferencias,sizeof(preferencias),F);
  fclose(F);
END;

FUNCTION Jugar();
PRIVATE
  i;
BEGIN
  put_screen(fotos,mapa);
  vs=0;
  winner=-1;
  nvivos=0;
  playing=1;
  for(i=0;i<npl;i++)
    ids[i]=Jugador(i);
  end;
  sound(inicio,256,256);
  while(nvivos<npl)
    frame;
  end;
  itlch=ItemLauncher();
  while(nvivos>1)
    frame;
    if(key(_esc)) exit("Rajados...",0); end;
  end;
  playing=0;
  if (nvivos==1)
    for(i=0;i<npl;i++)
      if(ids[i].vivo)
        winner=i;
        ptos[i]++;
        ids[i].vivo=0;
      end;
    end;
  end;
  //Visualizar resultados
  Resultados();

  signal(type Jugador,s_kill_tree);
  signal(type ItemLauncher,s_kill_tree);
  signal(type Disparo,s_kill_tree);
  signal(type BombaH,s_kill_tree);
  signal(type Cerradura,s_kill_tree);
  signal(type traya,s_kill);
  signal(type Item,s_kill_tree);
  signal(type boca,s_kill);
  Mapa++; if(mapa>maxmap) mapa=minmap; end;
END;

FUNCTION JugarVs();
PRIVATE
  i;
BEGIN
  put_screen(fotos,mapa);
  vs=1;
  winner=-1;
  nvivos=0;
  playing=1;
  for(i=0;i<npl;i++)
    ids[i]=Jugador(i);
  end;
  sound(inicio,128,256);
  while(nvivos<npl)
    frame;
    if(key(_esc)) exit("Rajados...",0); end;
  end;
  itlch=ItemLauncher();
  while(((ids[0].vivo+ids[2].vivo)>0) and ((ids[1].vivo+ids[3].vivo)>0))
    frame;
  end;
  playing=0;
  for(i=0;i<npl;i++)
    if(ids[i].vivo)
      winner=i%2;
      ptos[i]++;
    end;
  end;
  //Visualizar resultados
  ResultadosVS();

  signal(type Jugador,s_kill_tree);
  signal(type ItemLauncher,s_kill_tree);
  signal(type Disparo,s_kill_tree);
  signal(type BombaH,s_kill_tree);
  signal(type Cerradura,s_kill_tree);
  signal(type traya,s_kill);
  signal(type Item,s_kill_tree);
  signal(type boca,s_kill);
  Mapa++; if(mapa>maxmap) mapa=minmap; end;
END;


PROCESS Bandas();
BEGIN
  for(z=1;z<=6;z++)
    get_point(fotos,207,z,&x,&y);
    if(x+y>0)
      if(z%2==0)
        banda(x,y,90000,0);
      else
        banda(x,y,0,0);
      end;
    end;
  end;
END

PROCESS Banda(x,y,angle,fase);
private
  m=0,TC=200,TA=200,TI=30,TT;
BEGIN
  m=fase;
  TT=TC+TA+2*TI;
  file=fotos;
  graph=30;
  region=1;
  while(playing)
    m++;
    switch(m%TT)
      case 0..(TC-1):
        graph=30;
        end;
      case (TC)..(TC+TI-1):
        graph=30+(m%TT-TC)*10/TI;
        end;
      case (TC+TI)..(TC+TI+TA-1):
        graph=39;
        end;
      case (TC+TI+TA)..(TT-1):
        graph=39-(m%TT-TC-TI-TA)*10/TI;
        end;
    end;
    z=collision(type jugador);
    while(z)
      z.vivo=0;
      z=collision(type jugador);
    end;
    frame;
  end;
  xput(file,graph,x,y,angle,size,flags,region);
END

PROCESS Guerra();
PRIVATE
  k=0,x2=0,y2=0;
BEGIN
  while(playing)
    if(rand(0,200)==1)
      k=rand(0,1);
      get_point(fotos,206,1+2*k,&x,&y);
      get_point(fotos,206,2+2*k,&x2,&y2);
      dir=fget_angle(x,y,x2,y2);
      rx=x*1000;
      ry=y*1000;
      for(z=0;z<30;z++)
        Traya(id,rand(-5000,5000),rand(10,30),10);
      end;
      sound(explosion,256,256);
    end;
    frame;
  end;
END

PROCESS Mano();
PRIVATE
  zona=0;
  resta=100;
  ax=800,ay=600;
  audio=0;
BEGIN
  file=fotos;
  graph=7;
  region=1;
  x=800;
  y=600;
  while(playing)
    if(resta<=0)
      stop_sound(audio);
      audio=0;
      if(rand(0,1))
        //No seguir en las proximidades
        if(rand(0,1))
          zona=0;
        else
          zona=rand(1,30);
        end;
      end;
      ax=0; ay=0; resta=100;
      if(zona!=0)
        get_point(fotos,205,zona,&ax,&ay);
        ax+=rand(-20,20);
      end;
    end;

    flags=(collision(type jugador)!=0)*4;
    if(zona!=0)
      if(fget_dist(x,y,ax,ay)<4)
        if(audio==0)
          audio=sound(torno,256,256);
        end;
        resta--;
        x+=rand(-3,3);
        y+=rand(-3,3);
        put_pixel(x,y,0);
      else
        //aproximaci¢n
        if(audio!=0)
          stop_sound(audio);
          audio=0;
        end;
        xadvance(fget_angle(x,y,ax,ay),6);
      end;
    else
      if(audio!=0)
        stop_sound(audio);
        audio=0;
      end;
      xadvance(fget_angle(x,y,800,600),6);
      resta--;
    end;
    frame;
  end;
  /*if(audio!=0)*/ stop_sound(audio); /*end;*/
END;


PROCESS ItemLauncher()
PRIVATE
  nfr=0,next,clase,tipo,i;
BEGIN
  Portal();
  if(mapa==205) Mano(); end;
  if(mapa==206) Guerra(); end;
  if(mapa==207) Bandas(); end;
  for(z=0;z<6;z++)
   switch(i=rand(0,1000))
    case 0..399:
      clase=0;
      tipo=rand(1,7);
    end;
    case 400..899:
      clase=1;
      switch((i-400)/4)
        case 0..19:
          tipo=1;
        end;
        case 20..34:
          tipo=2;
        end;
        case 35..54:
          tipo=3;
        end;
        case 55..64:
          tipo=5;
        end;
        case 65..79:
          tipo=6;
        end;
        case 80..99:
          tipo=7;
        end;
        default:
          tipo=4;
        end;
      end;
    end;
    default:
      clase=-1;
      tipo=0;
    end;
   end;
   Item(rand(20,730),rand(20,580),clase,tipo);
  end;
  next=rand(100,400);
  while(playing)
    FRAME;
    nfr++;
    if(nfr>=next)
      next=nfr+rand(200,800);
   switch(i=rand(0,1000))
    case 0..399:
      clase=0;
      tipo=rand(1,7);
    end;
    case 400..899:
      clase=1;
      switch((i-400)/4)
        case 0..19:
          tipo=1;
        end;
        case 20..34:
          tipo=2;
        end;
        case 35..54:
          tipo=3;
        end;
        case 55..64:
          tipo=5;
        end;
        case 65..79:
          tipo=6;
        end;
        case 80..99:
          tipo=7;
        end;
        default:
          tipo=4;
        end;
      end;
    end;
    default:
      clase=-1;
      tipo=0;
    end;
   end;
      Item(rand(20,730),rand(20,580),clase,tipo);
    end;
  end;
END;

PROCESS Portal();
BEGIN
  bocas[0]=Boca(rand(10,739),rand(10,589),0);
  bocas[1]=Boca(rand(10,739),rand(10,589),1);
  while(playing)
    frame;
  end;
END;

PROCESS Boca(x,y,num);
PRIVATE
  sujeto=0,salida;
BEGIN
  file=boom;
  graph=rand(100,129);
  frame;
  salida=father.bocas[1-num];
  loop
    while(!playing) frame; end;
    graph++;
    if(graph>129) graph=100; end;

    //Captura de sujetos
    sujeto=collision(type Jugador);
    while(sujeto)
      sound(wc,256,256);
      sujeto.x=salida.x+cos(sujeto.dir)*15/1000;
      sujeto.y=salida.y-sin(sujeto.dir)*15/1000;
      sujeto.rx=salida.x*1000+cos(sujeto.dir)*15;
      sujeto.ry=salida.y*1000-sin(sujeto.dir)*15;
      sujeto=collision(type Jugador);
    end;

    sujeto=collision(type Disparo);
    while(sujeto)
      sujeto.x=salida.x+cos(sujeto.angle)*15/1000;
      sujeto.y=salida.y-sin(sujeto.angle)*15/1000;
      sujeto.rx=salida.x*1000+cos(sujeto.angle)*15;
      sujeto.ry=salida.y*1000-sin(sujeto.angle)*15;
      sujeto=collision(type Disparo);
    end;

    sujeto=get_id(type traya);
    while(sujeto)
      if(get_dist(sujeto)<18)
        put_pixel(sujeto.x,sujeto.y,0);
        sujeto.x=salida.x+cos(sujeto.dir)*20/1000;
        sujeto.y=salida.y-sin(sujeto.dir)*20/1000;
        sujeto.rx=salida.x*1000+cos(sujeto.dir)*20;
        sujeto.ry=salida.y*1000-sin(sujeto.dir)*20;
      end;
      sujeto=get_id(type Traya);
    end;

    frame;
  end;
END;

FUNCTION ¥(dir)
BEGIN
  dir%=360000;
  if(dir<0) dir+=360000; end;
  return(dir);
END;


FUNCTION Resultados();
PRIVATE
  i;
BEGIN
  delete_text(all_text);
  write(titlefont,400,100,4,"PUNTUACIONES");
  if(winner<>-1)
    write(titlefont,400,200,5,"Ganador: ");
    write(titlefont,400,200,3,Nombre[winner]);
  else
    write(titlefont,400,200,4,"Empate");
  end;
  for(i=0;i<npl;i++)
        write(panelfont,350,300+i*50,5,Nombre[i]);
    write_int(panelfont,450,300+i*50,5,&(Ptos[i]));
  end;
  write(panelfont,650,550,5,"¨Otra? (y/n)");
  WHILE(i!=_y and i!=_n)
    FRAME;
    i=scan_code;
  END;
  delete_text(all_text);
  sel=(i==_y)*(npl-1);
END;

FUNCTION ResultadosVs();
PRIVATE
  i,v,m;
BEGIN
  v=ptos[0]+ptos[2];
  m=ptos[1]+ptos[3];
  delete_text(all_text);
  write(titlefont,400,100,4,"PUNTUACIONES");
  if(winner<>-1)
    write(titlefont,400,200,5,"Ganadores: ");
    if(winner==0)
      write(titlefont,400,200,3," Violetas");
    else
      write(titlefont,400,200,3," Marrones");
    end;
  else
    write(titlefont,400,200,4,"Empate");
  end;
  write(panelfont,350,300,5,"Violetas ");
  write_int(panelfont,450,300,5,&v);
  write(panelfont,350,350,5,"Marrones");
  write_int(panelfont,450,350,5,&m);
  write(panelfont,650,550,5,"¨Otra? (y/n)");
  WHILE(i!=_y and i!=_n)
    FRAME;
    i=scan_code;
  END;
  delete_text(all_text);
  sel=(i==_y)*4;
END;


PROCESS Jugador(num);
PRIVATE
  ax,ay,i;
BEGIN
  region=1;
  vivo=1;
  file=fotos;
  graph=2;
  nvivos++;
  if(!vs)
   switch(num)
    case 0:
      color=52;
    end;
    case 1:
      color=114;
    end;
    case 2:
      color=32;
    end;
    case 3:
      color=60;
    end;
   end;
  else
    //colores vs
    if(num)
      color=215;
    else
      color=80;
    end;
  end;
  switch(npl)
    case 2:
      switch(num)
        case 0:
          rx=  50000;
          ry=  50000;
          dir=-45000;
        end;
        case 1:
          rx= 700000;
          ry= 550000;
          dir=135000;
        end;
      end;
    end;
    case 3:
      switch(num)
        case 0:
          rx=  50000;
          ry=  50000;
          dir=-45000;
        end;
        case 1:
          rx= 700000;
          ry=  50000;
          dir=225000;
        end;
        case 2:
          rx=  50000;
          ry= 550000;
          dir= 45000;
        end;
      end;
    end;
    case 4:
      switch(num)
        case 0:
          rx=  50000;
          ry=  50000;
          dir=-45000;
        end;
        case 1:
          rx= 700000;
          ry=  50000;
          dir=225000;
        end;
        case 2:
          rx=  50000;
          ry= 550000;
          dir= 45000;
        end;
        case 3:
          rx= 700000;
          ry= 550000;
          dir=135000;
        end;
      end;
    end;
  end;
  x=R(rx); y=R(ry);

  if(escudados) item(x,y,0,2); end;  //Escudos por defecto

  WHILE(vivo)
    while(!playing) frame; end;
    //A ver que hace el usuario
    if(num==3)
      if(mouse.x<oldx or key(Controls[num].der)) dir-=4000*ctrl; end;
      if(mouse.x>oldx or key(Controls[num].izq)) dir+=4000*ctrl; end;
      oldx=mouse.x;
    else
      dir+=(key(Controls[num].izq)-key(Controls[num].der))*4000*ctrl;
    end;

    //C lculos de trayectoria y colisi¢n
    rx+=cos(dir);
    ry-=sin(dir);
    ax=R(rx);
    ay=R(ry);
    if(ax>=749) rx-=750000; end;
    if(ax<0)    rx+=750000; end;
    if(ay>=599) ry-=600000; end;
    if(ay<0)    ry+=600000; end;

    ax=R(rx);
    ay=R(ry);
    if(ax!=x or ay!=y) //Cambio de posici¢n
      if (escudo<=0) //Habr  que comprobar si se palma
        if(!Chungo(id,ax,ay))
          if(ax!=x and ay!=y and(ax>2 and ay>2 and ay<598 and ax<748))
            if(Ondia(ax,ay,x,y))
              break;
            end;
          end;
        else
          break;
        end;
      end;
      if (collision(type Jugador) or collision(type traya)) break; end;
    end;

    put_pixel(x,y,color);
    x=ax;
    y=ay;
    if(vel>0)
      FRAME(vel);
    else
      FRAME(10);
    end;
  END;
  put_pixel(x,y,0);
  graph=0;
  vivo=0;
  nvivos--;
  if(playing)
    Puf();
    sound(uah,256,256);
  end; //Explosi¢n
  loop
    FRAME;
  end;
END;

FUNCTION Puf()
BEGIN
  x=father.x;
  y=father.y;
  _Puf(x,y);
  if(x<20)
    _Puf(x+750,y);
    if(y<20)
      _Puf(x,    y+600);
      _Puf(x+750,y+600);
    else
      if(y>580)
        _Puf(x,    y-600);
        _Puf(x+750,y-600);
      end;
    end;
  else
    if(x>730)
      _Puf(x-750,y);
      if(y<20)
        _Puf(x,    y+600);
        _Puf(x-750,y+600);
      else
        if(y>580)
          _Puf(x,    y-600);
          _Puf(x-750,y-600);
        end;
      end;
    else
      if(y<20)
        _Puf(x,y+600);
      else
        if(y>580) _Puf(x,y-600); end;
      end;
    end;
  end;
END;

PROCESS _Puf(x,y)
BEGIN
  region=1;
  file=boom;
  size=20;
  for(graph=1;graph<40;graph++)
    frame(100);
  end;
END;

FUNCTION Chungo(fid,x,y);
BEGIN
  if (fid.escudo>0) RETURN(0); end;

  switch(get_pixel(x,y))
    case fid.color:
      if (fid.cruces>0)
        RETURN(0);
      else
        RETURN(1);
      end;
    end;
    case 0:
      RETURN(0);
    end;
    default:
      RETURN(1);
    end;
  end;
END;

FUNCTION Ondia(x1,y1,x2,y2);
PRIVATE
 i,j,sol;
BEGIN
  //Ordenamos para evitar co¤as
  if (x1>x2) i=x1; x1=x2; x2=i; end;
  if (y1>y2) i=y1; y1=y2; y2=i; end;

  sol=0;
  for(i=x1;i<=x2;i++)
    for(j=y1;j<=y2;j++)
      sol+=Chungo(father,i,j);
    end;
  end;
  if (sol>=2)
    RETURN(1);
  else
    RETURN(0);
  end;
END;

FUNCTION R(coord);
PRIVATE
  res;
BEGIN
  res=coord/1000;
  if(coord%1000>500) res++; end;
  if(coord%1000<-500) res--; end;
  RETURN(res);
END;

PROCESS Item(x,y,clase,tipo);
PRIVATE
  tio;
BEGIN
  vivo=100;
  file=fotos;
  switch(clase)
    case -1:
      graph=124;
      clase=rand(1,2);
      tipo=rand(1,7);
    end;
    case 0: //Los autom ticos
      graph=tipo+109;
    end;
    case 1: //Los manuales
      graph=tipo+116;
    end;
  end;

  while(vivo>0)
    frame;
    tio=collision(type Jugador);
    if(tio and playing)
      //Asignar replicant
      switch(clase)
        case 0: //Los autom ticos
          switch(tipo)
            case 1:
              sound(shield,256,256);
              CMarck(tio);
            end;
            case 2:
              sound(shield,256,256);
              SMarck(tio);
            end;
            case 3:
              //Borrador
              put_screen(fotos,mapa);
              tio=get_id(type Cerradura);
              while(tio)
                tio.vivo=0;
                tio=get_id(type Cerradura);
              end;
              sound(reset,256,256);
            end;
            case 4:
              //Cambiar de trazos
              Cambiazo();
            end;
            case 5:
              //Controles transtornados
              Duende(tio);
            end;
            case 6:
              //Rapidez
              Parasito(tio,-50);
              sound(turbo,256,256);
            end;
            case 7:
              //Lentitud
              Parasito(tio,+50);
              sound(lento,256,256);
            end;
          end;
        end;
        case 1: //Los manuales
          Weapon(tio,tipo);
          if(tipo==7) sound(turbo,256,256); end;
        end;
      end;
      break;
    end;
    if (collision(type bombah)) break; end;
  end;
END;

PROCESS Parasito(idp,delta)
PRIVATE
  Calvario=1400;
BEGIN
  father=itlch;
  delta=(idp.vel*delta)/100;
  idp.vel+=delta;
  while(idp.vivo and calvario>0)
    calvario--;
    frame;
  end;
  idp.vel-=delta;
END;

PROCESS Duende(idp)
PRIVATE
  Calvario=700;
BEGIN
 if(idp.ctrl>0)
  father=itlch;
  idp.ctrl=-1;
  while(idp.vivo and calvario>0)
    calvario--;
    frame;
  end;
  idp.ctrl=1;
 end;
END;

PROCESS SMarck(idp);
PRIVATE
  text,seg;
BEGIN
  if(idp.escudo>0)
    idp.escudo=2100;
  else
    idp.escudo=2100;
    file=fotos;
    seg=idp.escudo/70;
    graph=11;
    y=idp.num*150+75;
    x=775;
    text=write_int(panelfont,x,y,4,&seg);

    while(idp.vivo and idp.escudo>0)
      frame;
      idp.escudo--;
      seg=idp.escudo/70;
    end;

    delete_text(text);
  end;
END;

PROCESS CMarck(idp);
PRIVATE
  text,seg;
BEGIN
  if(idp.cruces>0)
    idp.cruces=2100;
  else
    idp.cruces=2100;
    file=fotos;
    seg=idp.cruces/70;
    graph=10;
    y=idp.num*150+30;
    x=775;
    text=write_int(panelfont,x,y,4,&seg);

    while(idp.vivo and idp.cruces>0)
      frame;
      idp.cruces--;
      seg=idp.cruces/70;
    end;

    delete_text(text);
  end;
END;

PROCESS Weapon(idp,tipo);
PRIVATE
  text=0,info,factor,k=0,audio=0;
BEGIN
  idp.fase=-1;
  audio=0;
  father=itlch;
  if(idp.vivo)
    if(idp.target)
      idp.ammo=0;
      while(idp.target)
        frame;
      end;
    end;
    idp.target=1;
    x=775;
    y=idp.num*150+120;
    graph=tipo+16;
    file=fotos;
    if(tipo<>5 and tipo<>7)
      sound(armado,256,256);
    end;
    switch(tipo)
      case 1,6: //Tiros,escopeta
        factor=1;
        idp.ammo=20;
      end;
      case 2:
        factor=1;
        idp.ammo=200;
      end;
      case 3,7:   //Ametralladora,velocidad
        factor=70;
        idp.ammo=700;
      end;
      case 4,5: //MisilH,cerrar bordes
        factor=1;
        idp.ammo=1;
      end;
    end;
    if(!(tipo==4 or tipo==5))
      text=write_int(panelfont,x,y,4,&info);
    end;

    info=idp.ammo/factor;
    while(idp.vivo and (idp.ammo>0) and playing)
      frame;
      if(key(Controls[idp.num].esp) or (idp.num==3 and mouse.left))
        idp.fase++;
      else
        idp.fase=-1;
      end;
      if(idp.fase==0)
        switch(tipo)
          case 1: //Disparos
            Disparo(idp.rx,idp.ry,idp.dir);
            idp.ammo--;
            sound(tiro,256,256);
          end;
          case 4:
            BombaH(idp.rx,idp.ry,idp.dir);
            idp.ammo--;
          end;
          case 5: //cerrar
            cerradura(idp.color);
            idp.ammo--;
          end;
          case 6: //escopeta
            for(z=0;z<30;z++)
              Traya(idp,rand(-5000,5000),rand(10,30),10);
            end;
            idp.ammo--;
            sound(escopeta,256,256);
          end;
        end;
      end;
      //Trayas
      if(tipo==3)
        if(idp.fase>-1)
          for(z=0;z<20;z++)
            Traya(idp,rand(-30000,30000),rand(10,50),1);
          end;
          idp.ammo--;
          if(audio==0)
            audio=sound(straya,256,256);
          end;
        else
          if(audio!=0) stop_sound(audio); audio=0; end;
        end;
      end;
      //Fusil
      if(tipo==2 and idp.fase%20==0)
        sound(fusil,256,256);
        Rafaga(idp);
        idp.ammo-=5;
      end;
      //Velocidad
      if(tipo==7 and idp.fase>-1)
        if(!k)
          k=1;
          idp.vel-=50;
          sound(turbo,256,256);
        end;
        idp.ammo--;
      else
        if(k)
          k=0;
          idp.vel+=50;
        end;
      end;
      info=idp.ammo/factor;
    end;
    if(text!=0) delete_text(text); end;
    if((tipo==7) and k) idp.vel+=50; end;
    if(audio!=0) stop_sound(audio); end;
    idp.target=0;
  end;
END;

PROCESS Traya(idp,desv,vel,vivo)
PRIVATE
  i,j;
BEGIN
  dir=idp.dir+desv;
  rx=idp.rx;
  ry=idp.ry;

  for(i=0;i<100/idp.vel-1;i++)
    rx+=cos(dir)*vel;
    ry-=sin(dir)*vel;
    x=R(rx);
    y=R(ry);
    if(x>=749) rx-=750000; end;
    if(x<0)    rx+=750000; end;
    if(y>=599) ry-=600000; end;
    if(y<0)    ry+=600000; end;
    x=R(rx);
    y=R(ry);
  end;

  while(vivo>0)
    while(!playing) frame; end;
    put_pixel(x,y,0);
    vivo--;
    rx+=cos(dir)*vel;
    ry-=sin(dir)*vel;
    x=R(rx);
    y=R(ry);
    if(x>=749) rx-=750000; end;
    if(x<0)    rx+=750000; end;
    if(y>=599) ry-=600000; end;
    if(y<0)    ry+=600000; end;
    x=R(rx);
    y=R(ry);
    if(get_pixel(x,y)<>0) vivo=0; end;
    put_pixel(x,y,255);
    frame;
    i=get_id(type jugador);
    while(i)
      if(abs(i.x-x)<=1 and abs(i.y-y)<=1)
        i.vivo=0;
        vivo=0;
      end;
      i=get_id(type jugador);
    end;
  end;
  for(i=x-1;i<=x+1;i++)
    for(j=y-1;j<=y+1;j++)
      put_pixel(i,j,0);
    end;
  end;
  frame;
END;

PROCESS Rafaga(idp)
PRIVATE
  balas[5],i;
BEGIN
  for(i=0;i<5;i++)
    balas[i]=Traya(idp,0,5,120);
    frame(100);
  end;
  while(vivo>0 and playing)
    vivo=5;
    for(i=0;i<5;i++)
      if(balas[i])
       if (balas[i].vivo==0)
        balas[i]=0;
        vivo--;
       end;
      end;
    end;
    frame;
  end;
  for(i=0;i<5;i++)
    if(balas[i]) balas[i].vivo=0; end;
  end;
END;

PROCESS Disparo(rx,ry,angle);
PRIVATE
  ax,ay,px,py,i,j,listo;
BEGIN
  region=1;
  file=fotos;
  graph=5;
  x=R(rx);
  y=R(ry);
  listo=0;
  while(!listo)
    while(!playing) frame; end;
    frame;

    //C lculos de trayectoria y colisi¢n
    rx+=cos(angle)*5;
    ry-=sin(angle)*5;
    x=R(rx);
    y=R(ry);
    if(x>=749) rx-=750000; end;
    if(x<0)    rx+=750000; end;
    if(y>=599) ry-=600000; end;
    if(y<0)    ry+=600000; end;
    x=R(rx);
    y=R(ry);

    if (collision(type Jugador) or collision(type item) or collision(type banda)) break; end;
    for(i=0;i<10;i++)
      get_real_point(i,&px,&py);
      if(get_pixel(Lx(px),Ly(py))<>0) listo=1;
        break;
      end;
    end;
  end;
  sound(explosion,256,rand(270,330));
  Puf();
  for(i=px-5;i<px+5;i++)
    for(j=py-5;j<py+5;j++)
      put_pixel(Lx(i),Ly(j),0);
    end;
  end;
  i=get_id(type Jugador);
  while(i)
    if(i.vivo and abs(i.x-lx(px))<6 and abs(i.y-ly(py))<6)
      i.vivo=0;
    end;
    i=get_id(type Jugador);
  end;
  i=get_id(type Item);
  while(i)
    if((abs(i.x-lx(px))<16 or abs(i.x-lx(px))>734) and (abs(i.y-ly(py))<16 or abs(i.y-ly(py))>584))
      i.vivo-=50;
      if(i.vivo<0) i.vivo=0; end;
    end;
    i=get_id(type Item);
  end;
END;

PROCESS BombaH(rx,ry,angle);
PRIVATE
  ax,ay,px,py,i,j,listo;
BEGIN
  sound(bombava,256,256);
  region=1;
  file=fotos;
  graph=4;//xgraph=offset bgraph;
  rx+=cos(angle)*2;
  ry-=sin(angle)*2;
  x=R(rx);
  y=R(ry);
  listo=0;
  while(!listo)
    while(!playing) frame; end;
    frame;

    //C lculos de trayectoria y colisi¢n
    rx+=cos(angle)*2;
    ry-=sin(angle)*2;
    x=R(rx);
    y=R(ry);
    if(x>=750) rx-=750000; end;
    if(x<0)    rx+=750000; end;
    if(y>=600) ry-=600000; end;
    if(y<0)    ry+=600000; end;
    x=R(rx);
    y=R(ry);

    if (collision(type Jugador) or collision(type item)) break; end;
    for(i=1;i<=20;i++)
      get_real_point(i,&px,&py);
      if(get_pixel(lx(px),ly(py))<>0) listo=1;
        break;
      end;
    end;
  end;
  Devastacion();
  for(i=x-60;i<x+60;i++)
    for(j=y-60;j<y+60;j++)
      put_pixel(Lx(i),ly(j),0);
    end;
  end;

  i=get_id(type Jugador);
  while(i)
    rx=abs(i.x-x);
    ry=abs(i.y-y);
    if(i.vivo and (rx<50 or rx>700) and (ry<50 or ry>550))
      i.vivo=0;
    end;
    i=get_id(type Jugador);
  end;
  i=get_id(type Item);
  while(i)
    if((abs(i.x-x)<70 or abs(i.x-x)>680) and (abs(i.y-y)<70 or abs(i.y-y)>530))
      signal(i,s_kill);
    end;
    i=get_id(type Item);
  end;
END;

FUNCTION Devastacion()
BEGIN
  sound(explosi¢n,256,256);
  x=father.x;
  y=father.y;
  z=-10;
  _Dev(x,y);
  if(x<100)
    _Dev(x+750,y);
    if(y<100)
      _Dev(x,    y+600);
      _Dev(x+750,y+600);
    else
      if(y>500)
        _Dev(x,    y-600);
        _Dev(x+750,y-600);
      end;
    end;
  else
    if(x>650)
      _Dev(x-750,y);
      if(y<100)
        _dev(x,    y+600);
        _dev(x-750,y+600);
      else
        if(y>500)
          _dev(x,    y-600);
          _dev(x-750,y-600);
        end;
      end;
    else
      if(y<100)
        _dev(x,y+600);
      else
        if(y>500)
          _dev(x,y-600);
        end;
      end;
    end;
  end;
END;

PROCESS _Dev(x,y)
BEGIN
  size=150;
  father=itlch;
  region=1;
  file=boom;
  for(graph=1;graph<40;graph++)
    frame(150);
  end;
END;

PROCESS Cerradura(color)
PRIVATE
  i,audio;
BEGIN
  vivo=1;
  audio=sound(alarma,256,256);
  father=itlch;
  for(z=0;z<150;z++)
    if (!(playing and vivo>0)) break; end;
    for(i=0;i<5;i++)
      if (!(playing and vivo>0)) break; end;
      put_pixel(z+i*150,0,color);
      put_pixel(z+i*150,599,color);
      if(i<>5)
        put_pixel(0,z+150*i,color);
        put_pixel(749,z+150*i,color);
      end;
    end;
    frame(120);
  end;
  stop_sound(audio);
END;

FUNCTION LX(x)
BEGIN
  x%=750;
  if(x<0) x+=750; end;
  return(x);
END;

FUNCTION LY(y)
BEGIN
  y%=600;
  if(y<0) y+=600; end;
  return(y);
END;

FUNCTION Cambiazo()
PRIVATE
  idt[4],i,j,p,k;
BEGIN
    z=0;
    for(i=0;i<npl;i++)
      if(ids[i].vivo)
        idt[z]=ids[i];
        z++;
      end;
    end;
    if(z>1)
      //Cambiar posicion y spin
      x=idt[0].x;
      y=idt[0].y;
      rx=idt[0].rx;
      ry=idt[0].ry;
      dir=idt[0].dir;
      for(i=0;i<z-1;i++)
        idt[i].x=idt[i+1].x;
        idt[i].y=idt[i+1].y;
        idt[i].rx=idt[i+1].rx;
        idt[i].ry=idt[i+1].ry;
        idt[i].dir=idt[i+1].dir;
      end;
      idt[z-1].x=x;
      idt[z-1].y=y;
      idt[z-1].rx=rx;
      idt[z-1].ry=ry;
      idt[z-1].dir=dir;
    end;
END;