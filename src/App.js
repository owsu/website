import "./App.css"

function App() {
  const projects = [
    {
      title: "VocalDNA",
      content: "ML Project that me and a team developed during MadHacks that works as a full-stack web application that predicts users demographic (age range, gender, accent region) with 80% accuracy." ,
      link: "https://github.com/owsu/VocalDNA"},
    {
      title: "RoliTrade",
      content: "An automated trading bot that uses REST API to determine if trades are beneficial to take or not, and posts trades onto Rolimons automatically in a variable time frame." ,
      link: "https://github.com/owsu/rolimon-trading-bot"},
    {
      title: "Random Gear Battles",
      content: "An online game I made on Roblox that has people fight in a battle arena with other players and bots using a stat system and weapons that they have to roll to get." ,
      link: "https://github.com/owsu/RandomGearBattles"},
  ]

  const experiences = [
    {
      title: "Data Engineering Research Assistant",
      company: "Space Science and Engineering Center (SSEC)",
      date: "September, 2025 - Current",
      content: "A small research team position with Distinguished Scientist Sanjay Limaye in the Astrobiology field where I am tasked with created Python functions to properly handle NASA & JAXA Akatsuki mission data and to help research the possibilities of extraterrestrial lifeforms on Venus."},
    {
      title: "Videogame Developer",
      company: "Roblox",
      date: "June 2025 - August 2025",
      content: "Built custom programs using Luau in Roblox Studio for game development studios and for solo dev work. Contributed on multiple games as a programmer racking up a total of over 100k+ visits and hundreds of in-app purchases."},
    {
      title: "Shift Manager",
      company: "Jimmy Johns",
      date: "July 2023 - August, 2025",
      content: "A management role in Jimmy Johns where I was tasked with making sure that the store operated properly in my shift. That included delegating tasks to other employees, training employees on how to do tasks, determining whether the proper amount of money was in the safe and register, ensuring customer satisfaction, and maintaining store cleanliness."},
  ]
  return (
    <div>
      <InfoBox title="Hello, I'm Owusu Kantankah" content="I am an undergrad at the University of Wisconsin - Madison majoring in Computer Science and Data Science. Though I dabble throughout many different fields in tech, I am most comfortable in software engineering roles. SWE work still remains one of the most versatile fields in the world, and will remain so even with the emergence of AI 😁." />

      <section>
        <InfoBox title="Projects" content="Below are a list of projects that I have, I never try to force a project every project that I make comes from a place of interest or genuine curiosity."/>
        <ul>
          {projects.map((p, index) => (
            <ProjectList
              key={index}
              title={p.title}
              content={p.content}
              link={p.link}
            />))}
        </ul>
      </section>
      

      <section>
        <InfoBox title="Experience" content="Here are the places that I've worked professionally over the years, some are tech related and others are more hands-on!"/>
        <ul>
          {experiences.map((p, index) => (
            <JobList
              key={index}
              title={p.title}
              company={p.company}
              date={p.date}
              content={p.content}
            />))}
        </ul>
      </section>
      
    </div>
  );
}

function InfoBox({title, content}) {
  return (
    <div className="info-box">
      <h2> {title} </h2>
      <p> {content} </p>
    </div>
  )
}

function ProjectList({title, content, link}) {
  return (
    <li>
      <h3> {title} </h3>
      <p>{content}</p>
      <a href={link} target="_blank" rel="noopener noreferrer">Link Here</a>
    </li>
  )
}

function JobList({title, company, date, content}) {
  return (
    <li>
      <h3> {title} </h3>
      <h4>{company}</h4>
      <p>{date}</p>
      <p>{content}</p>
    </li>
  )
}
export default App;
